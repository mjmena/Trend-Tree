import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { discoveryReport } from './movement-review.mjs';

const hours = (later, earlier) => (later && earlier ? (Date.parse(later) - Date.parse(earlier)) / 3600000 : null);
const unique = (values) => [...new Set(values)];
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

function timingSummary(items, clock) {
  const pairs = items.map((item) => item[clock]).filter((value) => value != null);
  return {
    eligible_items: items.length,
    paired: pairs.length,
    unknown: items.length - pairs.length,
    median_hours: median(pairs),
  };
}

function identityAt(aliases) {
  const bySignal = Map.groupBy(aliases, (a) => a.signal);
  for (const history of bySignal.values())
    history.sort((a, b) => b.verified.localeCompare(a.verified) || a.story.localeCompare(b.story));
  return (id, at) => bySignal.get(id)?.find((a) => a.verified <= at)?.story || id;
}

function lifecycleAt(ledger, trend, at) {
  return ledger
    .filter((entry) => entry.trend === trend && entry.at <= at)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
}

function auditOutcome(audit, states, trends) {
  const target = trends.get(audit.target);
  const state = states.find((s) => s.chain === audit.chain && s.decision === audit.decision && s.at <= audit.at);
  let disposition = 'unconfirmed_audit';
  if (audit.category === 'EDITORIAL') disposition = 'editorial';
  else if (audit.decision === 'PROMOTE_NEW' && target?.candidate === audit.candidate && target.minted <= audit.at)
    disposition = 'confirmed_new';
  else if (
    state &&
    audit.decision === 'MERGE_INTO_EXISTING' &&
    target &&
    state.promoted_to === target.id &&
    target.minted <= state.at
  )
    disposition = 'merged_existing';
  else if (state?.leader && audit.decision === 'MERGE_INTO_CANDIDATE') {
    if (target && state.promoted_to === target.id && target.minted <= state.at) disposition = 'merged_via_candidate';
    else if (!audit.target && state.rejected && state.rejection_reason?.startsWith(`leader_${state.leader}_rejected:`))
      disposition = 'mirrored_reject';
    else if (!audit.target && state.deferred && state.defer_reason?.startsWith(`leader_${state.leader}_deferred:`))
      disposition = 'mirrored_defer';
  } else if (state && audit.decision === 'DEFER' && state.deferred) disposition = 'deferred';
  else if (state && audit.decision === 'REJECT' && state.rejected) disposition = 'rejected';
  return { ...audit, disposition, minted: target?.minted, leader: state?.leader };
}

function candidateOutcomes(packet, eligible, credit, cutoff) {
  const trends = new Map((packet.trends || []).map((t) => [t.id, t]));
  const states = Map.groupBy(
    (packet.states || []).sort((a, b) => b.at.localeCompare(a.at)),
    (s) => s.candidate
  );
  const audits = Map.groupBy(
    (packet.audits || []).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    (a) => a.candidate
  );
  const byStory = Map.groupBy(eligible, (a) => a.story);
  const facts = new Map((packet.signal_facts || []).map((f) => [f.signal, f]));
  const cases = [];
  for (const candidate of packet.candidates || []) {
    const support = candidate.support || [];
    const articles = unique(support.map((id) => credit(id, cutoff))).flatMap((id) => byStory.get(id) || []);
    if (!articles.length) continue;
    const available = articles.filter(
      (a) =>
        a.handled <= candidate.created &&
        support.some((id) => {
          const embedded = facts.get(id)?.embedded || (a.signal === id ? a.embedded : null);
          return (
            embedded &&
            embedded <= candidate.created &&
            credit(id, candidate.created) === credit(a.signal, candidate.created)
          );
        })
    );
    const history = (audits.get(candidate.id) || []).map((a) =>
      auditOutcome(a, states.get(candidate.id) || [], trends)
    );
    const identities = [...trends.values()].filter((t) => t.candidate === candidate.id);
    const missing = identities.filter((t) => !history.some((a) => a.decision === 'PROMOTE_NEW' && a.target === t.id));
    const disposition = !available.length
      ? 'preceded_article'
      : missing.length
        ? 'identity_without_audit'
        : history.at(-1)?.disposition || 'unknown_pending';
    cases.push({
      ...candidate,
      article_ids: articles.map((a) => a.id),
      story_ids: unique(articles.map((a) => a.story)),
      available_article_ids: available.map((a) => a.id),
      available_story_ids: unique(available.map((a) => a.story)),
      target_at_observation: unique(history.map((d) => d.target).filter(Boolean)).flatMap((target) =>
        articles.map((a) => {
          const minted = trends.get(target)?.minted;
          const evaluation = lifecycleAt(packet.lifecycle || [], target, a.first);
          return {
            target,
            article: a.id,
            observed: a.first,
            minted,
            evaluation_id: evaluation?.id,
            status: minted && minted <= a.first ? evaluation?.status || 'NEW' : 'not_minted_at_poll',
          };
        })
      ),
      history,
      identities_without_audit: missing.map((t) => t.id),
      disposition,
      followup_hours: hours(cutoff, candidate.created),
    });
  }
  return cases;
}

const pairKey = (story, trend) => JSON.stringify([story, trend]);

function attributedPairs(packet, eligible, credit, reviews) {
  const stories = Map.groupBy(eligible, (a) => a.story);
  const trends = new Map((packet.trends || []).map((t) => [t.id, t]));
  const links = Map.groupBy(packet.links || [], (l) => pairKey(l.story, l.trend));
  const sweeps = Map.groupBy(packet.sweeps || [], (s) => pairKey(s.story, s.trend));
  const cases = [];
  for (const key of unique([...links.keys(), ...sweeps.keys()])) {
    const [story, trend] = JSON.parse(key);
    const items = stories.get(story);
    if (!items) continue;
    const ordered = [...items].sort((a, b) => a.first.localeCompare(b.first) || a.id.localeCompare(b.id));
    const associations = (links.get(key) || []).sort(
      (a, b) => a.at.localeCompare(b.at) || b.kind.localeCompare(a.kind)
    );
    const link = associations[0];
    const considered = sweeps.get(key) || [];
    const availableAt = (a, signal, at, embedded) =>
      a.handled <= at && embedded && embedded <= at && credit(signal, at) === credit(a.signal, at);
    const eligibleForSweep = (a, s) => s.selected && s.selected <= s.submitted &&
      availableAt(a, s.signal, s.selected, s.embedded) && hours(s.selected, s.embedded) <= 72;
    const sweep = considered.find((s) =>
      link && s.signal === link.signal && s.state === 'COLLECTED' && s.submitted <= link.at && s.updated >= link.at &&
      s.rank >= 1 && s.rank <= 20 && s.similarity >= 0.35
    );
    const minted = trends.get(trend)?.minted;
    const selection = sweep ? sweep.selected : link?.at;
    const item_outcomes = ordered.map((a) => {
      const state = lifecycleAt(packet.lifecycle || [], trend, a.first);
      const status = state?.status || 'NEW';
      const available = Boolean(link && (sweep ? eligibleForSweep(a, sweep) : availableAt(a, link.signal, link.at, a.embedded)));
      let disposition = 'verified_active_attribution';
      if (link && link.at <= a.first) disposition = 'already_linked';
      else if (selection && selection < a.handled) disposition = 'preceded_item';
      else if (!minted || minted > a.first) disposition = 'not_minted_at_poll';
      else if (['DORMANT', 'RETIRED'].includes(status)) disposition = 'inactive_at_poll';
      else if (!link) disposition = 'considered_without_link';
      else if (link.kind === 'supporting') disposition = 'supporting';
      else if (!available || link.kind !== 'attributed' || !sweep) disposition = 'unverified_attribution';
      return {article:a.id, observed:a.first, status, lifecycle_id:state?.id || null, available, disposition};
    });
    const reference = item_outcomes.find((i) => i.disposition === 'verified_active_attribution') || item_outcomes[0];
    const prior_facts = [
      ...(packet.prior_links || []).map((l) => ({ ...l, id: l.signal })),
      ...(packet.prior_enrichments || []),
    ].filter((f) => f.trend === trend && f.at <= reference.observed);
    cases.push({
      story,
      trend,
      article_ids: items.map((a) => a.id),
      available_article_ids: item_outcomes.filter((i) => i.available).map((i) => i.article),
      item_outcomes,
      observed: reference.observed,
      minted,
      status: reference.status,
      lifecycle_id: reference.lifecycle_id,
      first_link: link || null,
      sweep: sweep || null,
      considered,
      disposition: reference.disposition,
      prior_facts,
      fact_review: null,
    });
  }
  for (const review of reviews) {
    const pair = cases.find((c) => c.story === review.story && c.trend === review.trend);
    if (
      pair?.disposition !== 'verified_active_attribution' ||
      pair.fact_review ||
      !review.reviewer ||
      !review.reason ||
      !['fresh', 'already_known', 'unknown'].includes(review.disposition) ||
      (review.disposition !== 'unknown' && !review.fact)
    )
      throw new Error('Invalid or duplicate prior-fact review');
    const references = new Set(pair.prior_facts.map((f) => f.id));
    const substantive = pair.prior_facts.filter(
      (f) => f.title || f.body || f.url || (f.evidence && Object.keys(f.evidence).length)
    );
    if (review.disposition !== 'unknown' && !substantive.some((f) => review.prior_ids?.includes(f.id))) {
      throw new Error('A substantive prior reference is required for a fresh or previously known fact');
    }
    if (
      !Array.isArray(review.prior_ids) ||
      review.prior_ids.some((id) => !references.has(id)) ||
      (references.size && !review.prior_ids.length && review.disposition !== 'unknown')
    )
      throw new Error('Cite pre-observation prior facts for the pair');
    pair.fact_review = review;
  }
  return cases;
}

export function contributionReport(packet, reviews = {}) {
  if (packet.window?.length !== 1) throw new Error('The report requires exactly one intake control row');
  const [window] = packet.window;
  if (!window.enabled || window.cutoff < window.end) {
    return { window, status: 'awaiting_seven_complete_utc_days', outcomes: null };
  }
  const article_cases = (packet.articles || []).map((a) => {
    const replay = a.first_origin === 'replay' || a.origin === 'replay';
    const timing_disposition = replay
      ? 'replay'
      : !a.eligible
        ? 'unusable_at_cutoff'
        : !a.native
          ? 'unknown_no_exact_native_url'
          : 'paired';
    const source_role = !a.eligible
      ? 'unusable'
      : !a.embedded
        ? 'awaiting_embedding'
        : a.story_origin === 'replay' || replay
          ? 'recovered_story'
          : a.story_first && a.story_first < window.start
            ? 'previously_observed_story'
            : (a.story_writer || a.writer) === 'trend_hunter'
              ? 'feed_first_writer'
              : 'native_first_writer';
    return {
      ...a,
      timing_disposition,
      source_role,
      pickup_lead_hours: replay ? null : hours(a.native, a.pickup),
      eligible_poll_lead_hours: replay ? null : hours(a.native, a.eligible),
      followup_hours: hours(window.cutoff, a.first),
    };
  });
  const live = article_cases.filter((a) => a.timing_disposition !== 'replay');
  const eligible = live.filter((a) => a.eligible && a.story);
  const credit = identityAt(packet.aliases || []);
  const candidate_cases = candidateOutcomes(packet, eligible, credit, window.cutoff);
  const associated = candidate_cases.filter((c) => c.available_story_ids.length).flatMap((c) => c.history);
  const link_cases = attributedPairs(packet, eligible, credit, reviews.facts || []);
  const verified = link_cases.filter((c) => c.disposition === 'verified_active_attribution');
  const discovery = discoveryReport({ ...packet, movementReviews: reviews.movements || [] }, window, eligible, credit);
  const trends = new Map((packet.trends || []).map((t) => [t.id, t]));
  const candidates = new Map((packet.candidates || []).map((c) => [c.id, c]));
  for (const sample of discovery.sample) {
    sample.candidate_history = sample.candidate_ids.map((id) => ({
      candidate: candidates.get(id),
      decisions: (packet.audits || [])
        .filter((a) => a.candidate === id)
        .map((a) =>
          auditOutcome(
            a,
            (packet.states || []).filter((s) => s.candidate === id),
            trends
          )
        ),
      committed_states: (packet.states || []).filter((s) => s.candidate === id),
    }));
  }
  const fresh = verified.filter((c) => c.fact_review?.disposition === 'fresh');
  const byStory = Map.groupBy(eligible, (a) => a.story);
  const supported = new Set(candidate_cases.flatMap((c) => c.available_story_ids));
  const attributed = new Set(verified.map((l) => l.story));
  const knownStories = new Set([...candidate_cases.flatMap((c) => c.story_ids),
    ...link_cases.filter((l) => l.first_link).map((l) => l.story)]);
  for (const a of article_cases) {
    a.candidate_ids = candidate_cases.filter((c) => c.available_article_ids.includes(a.id)).map((c) => c.id);
    const links = link_cases.filter((l) => l.available_article_ids.includes(a.id));
    a.trend_ids = unique(links.map((l) => l.trend));
    a.active_trend_ids = links.filter((l) => l.item_outcomes.some((i) =>
      i.article === a.id && i.disposition === 'verified_active_attribution')).map((l) => l.trend);
    a.outcome_disposition =
      a.timing_disposition === 'replay'
        ? 'replay'
        : !a.story
          ? 'unusable_at_cutoff'
          : a.candidate_ids.length || a.active_trend_ids.length
            ? 'observed_association'
            : a.trend_ids.length
              ? 'other_or_unverified_link'
              : candidate_cases.some((c) => c.article_ids.includes(a.id) && c.created < a.handled) ||
                  link_cases.some((l) => l.item_outcomes.some((i) => i.article === a.id && ['preceded_item','already_linked'].includes(i.disposition)))
                ? 'prior_story_association'
                : knownStories.has(a.story) ? 'story_association_without_item_credit' : 'unknown_unlinked_at_cutoff';
  }
  const days = packet.days || [];
  const forward_hours = days.reduce((sum, d) => sum + d.forward_hours, 0);
  const complete = window.through >= window.end && days.length === 7 && days.every((d) => d.forward_hours === 24);
  const nativeSources = [
    'agent_chatgpt_discovery',
    'agent_gemini_discovery',
    'agent_grok_discovery',
    'google_trends_rss',
    'gdelt',
    'gemini_other',
  ];
  const coverage = {
    days,
    forward_hours,
    expected_forward_hours: 168,
    observation_counts: packet.sightings || [],
    opportunities: (packet.opportunities || []).length,
    native_sources: nativeSources.map((source) => ({
      source,
      recorded_receipts: packet.native_coverage?.find((s) => s.source === source)?.receipts || 0,
      earliest_exact_matches: live.filter((a) => a.native_source === source).length,
    })),
    unavailable_native_sightings:
      'Pre-install discarded matches, discovery within-run deduplication, RSS per-query caps, GDELT in-call repeats and uninstrumented sources.',
  };
  const outcomes = {
    accepted_items: article_cases.length,
    live_observed_items: live.length,
    replay_items: article_cases.length - live.length,
    eligible_live_items: eligible.length,
    unusable_live_items: live.length - eligible.length,
    independent_live_stories: byStory.size,
    embedded_live_stories: unique(eligible.filter((a) => a.embedded).map((a) => a.story)).length,
    stories_supporting_candidates: supported.size,
    article_supported_candidates: candidate_cases.filter((c) => c.available_story_ids.length).length,
    feed_first_stories_supporting_candidates: unique(
      eligible.filter((a) => a.source_role === 'feed_first_writer' && supported.has(a.story)).map((a) => a.story)
    ).length,
    feed_first_stories_attributed: unique(
      eligible.filter((a) => a.source_role === 'feed_first_writer' && attributed.has(a.story)).map((a) => a.story)
    ).length,
    native_first_writer_stories: unique(
      eligible.filter((a) => a.source_role === 'native_first_writer').map((a) => a.story)
    ).length,
    feed_first_writer_stories: unique(eligible.filter((a) => a.source_role === 'feed_first_writer').map((a) => a.story))
      .length,
    previously_observed_or_recovered_stories: unique(
      eligible
        .filter((a) => ['previously_observed_story', 'recovered_story'].includes(a.source_role))
        .map((a) => a.story)
    ).length,
    pending_candidates: candidate_cases.filter((c) =>
      ['unknown_pending', 'deferred', 'mirrored_defer', 'unconfirmed_audit', 'identity_without_audit'].includes(
        c.disposition
      )
    ).length,
    confirmed_new_trends: unique(associated.filter((d) => d.disposition === 'confirmed_new').map((d) => d.target))
      .length,
    merged_target_trends: unique(
      associated.filter((d) => ['merged_existing', 'merged_via_candidate'].includes(d.disposition)).map((d) => d.target)
    ).length,
    active_attributed_stories: attributed.size,
    active_attributed_trends: unique(verified.map((c) => c.trend)).length,
    verified_active_pairs: verified.length,
    unverified_attribution_pairs: link_cases.filter((c) => c.disposition === 'unverified_attribution').length,
    reviewed_fact_pairs: verified.filter((c) => c.fact_review).length,
    unknown_fact_pairs: verified.filter((c) => !c.fact_review || c.fact_review.disposition === 'unknown').length,
    fresh_fact_pairs:
      fresh.length || (verified.some((c) => !c.fact_review || c.fact_review.disposition === 'unknown') ? null : 0),
    unknown_unlinked_stories: [...byStory.keys()].filter((story) => !knownStories.has(story)).length,
  };
  return {
    window,
    status: complete ? 'observed' : 'incomplete_intake_coverage',
    coverage,
    outcomes: complete ? outcomes : null,
    observed_subset: complete ? undefined : outcomes,
    article_timing: {
      pickup: timingSummary(live, 'pickup_lead_hours'),
      eligible_poll: timingSummary(eligible, 'eligible_poll_lead_hours'),
    },
    discovery,
    article_cases,
    candidate_cases,
    link_cases,
    examples: unique(
      [
        article_cases.find((a) => a.active_trend_ids.length)?.id,
        article_cases.find((a) => a.candidate_ids.length)?.id,
        article_cases.find((a) => a.outcome_disposition === 'unknown_unlinked_at_cutoff')?.id,
      ].filter(Boolean)
    ),
  };
}

function readCapture(path) {
  const contents = readFileSync(path);
  const packet = {};
  for (const row of JSON.parse(contents).flat()) {
    if (!row.SECTION) continue;
    const data = typeof row.DATA === 'string' ? JSON.parse(row.DATA) : row.DATA;
    const record = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k.toLowerCase() === 'at_utc' ? 'at' : k.toLowerCase(), v])
    );
    (packet[row.SECTION] ||= []).push(record);
  }
  const manifest = packet.manifest?.[0];
  if (
    manifest?.version !== 1 ||
    packet.window?.length !== 1 ||
    packet.days?.length !== 7 ||
    ['articles', 'candidates', 'opportunities'].some((name) => (packet[name]?.length || 0) !== manifest[name])
  ) {
    throw new Error('Incomplete Snowflake report export or missing intake control row');
  }
  return { packet, sha256: createHash('sha256').update(contents).digest('hex') };
}

function capture(cutoff, path) {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(cutoff) ||
    !Number.isFinite(Date.parse(cutoff)) ||
    Date.parse(cutoff) > Date.now()
  ) {
    throw new Error('Use a past UTC cutoff in ISO format with a trailing Z');
  }
  const sql =
    `SET cutoff='${new Date(cutoff).toISOString()}'::TIMESTAMP_TZ;\nSET report_snapshot=$cutoff;\n` +
    readFileSync(new URL('./report.sql', import.meta.url), 'utf8');
  const temporary = `${path}.${process.pid}.partial`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    const result = spawnSync(
      'snow',
      [
        'sql',
        '-c',
        process.env.SNOWFLAKE_CONNECTION || 'claude',
        '--database',
        'MCC_RAW',
        '--schema',
        'MARKETING_DEV',
        '--enable-templating',
        'NONE',
        '--format',
        'json',
        '--silent',
        '-i',
      ],
      { input: sql, stdio: ['pipe', fd, 'inherit'] }
    );
    if (result.error || result.status !== 0)
      throw result.error || new Error('Snowflake could not capture the requested cutoff');
    readCapture(temporary);
    linkSync(temporary, path);
  } finally {
    closeSync(fd);
    unlinkSync(temporary);
  }
}

function run([command, file, other]) {
  if (command === 'capture' && file && other) return capture(file, other);
  if (!['prepare', 'render'].includes(command) || !file)
    throw new Error('Use capture <cutoff-UTC> <new-packet.json> or prepare/render <packet.json> [reviews.json]');
  const { packet, sha256 } = readCapture(file);
  const reviews = other ? JSON.parse(readFileSync(other, 'utf8')) : {};
  if (other && reviews.packet_sha256 !== sha256) throw new Error('The review belongs to a different evidence packet');
  const report = contributionReport(packet, reviews);
  let output = report;
  if (command === 'prepare' && report.discovery) {
    const { seed, per_stratum, frame, sample } = report.discovery;
    output = {
      window: report.window,
      status: report.status,
      coverage: report.coverage,
      seed,
      per_stratum,
      frame,
      candidate_directory: (packet.candidates || []).map(({ id, topic, query, created, support }) => ({
        id,
        topic,
        query,
        created,
        support,
      })),
      sample: sample.map(({ seed, topic, stratum, candidate_ids, native, augmented }) => ({
        seed,
        topic,
        stratum,
        candidate_ids,
        native,
        augmented,
      })),
    };
  }
  process.stdout.write(JSON.stringify({ packet_sha256: sha256, ...output }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
