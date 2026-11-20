import { createHash } from 'node:crypto';
import { ET_MIN_ABSOLUTE_VOLUME, etQuerySource } from '../../agents/lib/exploding_topics.mjs';
import { classifyCandidate } from '../../agents/lib/promotion_gate.mjs';

const seed = 'trend-tree/article-week-v1';
const perStratum = 4;
const arms = ['native', 'augmented'];
const distinct = (values) => [...new Set(values)];
const hash = (id) =>
  createHash('sha256')
    .update(seed + '\0' + id)
    .digest('hex');
const key = (op, arm) => JSON.stringify([op, arm]);

function selectFrame(candidates, window, articles, credit) {
  // The editorial nomination writer uses the nomination ID for both candidate and chain.
  const inWeek = candidates.filter((c) => c.chain !== c.id && c.created >= window.start && c.created < window.end);
  const grouped = Map.groupBy(inWeek, (c) =>
    articles.some(
      (a) =>
        a.handled <= c.created &&
        a.embedded &&
        a.embedded <= c.created &&
        c.support?.some((id) => credit(id, c.created) === credit(a.signal, c.created))
    )
      ? 'with_article_support'
      : 'without_article_support'
  );
  const frame = [];
  const sample = [];
  for (const [stratum, cases] of [...grouped].sort()) {
    const ordered = cases
      .map((c) => ({ id: c.id, stratum, hash: hash(c.id) }))
      .sort((a, b) => a.hash.localeCompare(b.hash));
    frame.push(...ordered);
    sample.push(...ordered.slice(0, perStratum));
  }
  return { frame, sample };
}

function judge(judgment, available, packet, movement, opportunity) {
  if (!['meets', 'does_not_meet', 'uncertain'].includes(judgment.disposition) || !judgment.reason)
    throw new Error('An opportunity judgment needs a disposition and rationale');
  const ids = judgment.ids || [];
  const cited = ids.map((id) => available.find((r) => r.signal === id));
  if (cited.some((r) => !r)) throw new Error('Evidence is unavailable in this arm at this opportunity');
  if (judgment.disposition !== 'meets') return judgment;
  if (!judgment.query?.trim() || cited.length < 2 || distinct(cited.map((r) => r.independent_story)).length !== cited.length) {
    throw new Error('A positive review needs an atomic query and two or more independently credited in-pool IDs');
  }
  if (opportunity.lane === 'revisit' && (cited.some((r) => r.batch == null) || distinct(cited.map((r) => r.batch)).length !== 1)) {
    throw new Error('Revisit evidence must come from one dispatched batch');
  }
  if (judgment.query.trim().toLowerCase() !== movement.query?.trim().toLowerCase()) {
    throw new Error('Both arms must evaluate the fixed movement query');
  }
  const breakdown = Object.fromEntries(cited.map((r) => [r.source, 1]));
  const { action } = classifyCandidate({
    SOURCE_BREAKDOWN: breakdown,
    CONFIDENCE: judgment.confidence,
    SPECIFICITY_SCORE: judgment.specificity,
  });
  if (action === 'reject') throw new Error('The evidence falls below the promotion gate');
  if (action === 'route_et_rescue') {
    if (
      ![judgment.confidence, judgment.specificity].every((score) => Number.isFinite(score) && score >= 0 && score <= 1)
    ) {
      throw new Error('Single-family evidence needs numeric gate scores between zero and one');
    }
    const witness = (packet.states || []).find(
      (s) =>
        movement.candidates.includes(s.candidate) &&
        s.candidate === judgment.et_candidate &&
        s.at <= opportunity.at &&
        s.et_second === true &&
        s.et?.matched === true &&
        Number.isFinite(s.et.absolute_volume) &&
        s.et.absolute_volume > ET_MIN_ABSOLUTE_VOLUME &&
        s.et.keyword &&
        s.et.candidate_query?.trim().toLowerCase() === judgment.query.trim().toLowerCase() &&
        etQuerySource({ queried: s.et.queried, candidateQuery: s.et.candidate_query }) === 'candidate_query'
    );
    if (!witness)
      throw new Error('Single-family routing requires a contemporaneous same-movement Exploding Topics decision');
    return { ...judgment, gate: action, et_at: witness.at, et: witness.et };
  }
  return { ...judgment, gate: action };
}

function hasIndependentPair(rows, revisit) {
  const groups = revisit ? Map.groupBy(rows.filter((r) => r.batch != null), (r) => r.batch).values() : [rows];
  return [...groups].some((group) => distinct(group.map((r) => r.independent_story)).length >= 2);
}

function compareMovement(packet, movement, candidates, evidence, credit, cutoff) {
  const support = distinct(
    movement.candidates.flatMap((id) => candidates.get(id).support || []).concat(movement.extra_ids || [])
  );
  const stories = new Set(support.map((id) => credit(id, cutoff)));
  const judgments = new Map();
  for (const j of movement.judgments || []) {
    if (judgments.has(key(j.op, j.arm))) throw new Error('Duplicate opportunity judgment');
    judgments.set(key(j.op, j.arm), j);
  }
  const result = {};
  for (const arm of arms) {
    let first = null,
      earlierUnknown = false;
    const packets = [];
    for (const op of packet.opportunities || []) {
      const rows = (evidence.get(key(op.id, arm)) || [])
        .map((r) => ({...r, independent_story: credit(r.story, cutoff)}))
        .filter((r) => stories.has(r.independent_story) || stories.has(credit(r.signal, cutoff)));
      const selected = arm === 'augmented' ? op.selected_count : op.native_count;
      const hasFloor = selected >= op.floor;
      const replayFloor = arm === 'augmented' && selected - (op.excluded_feed_count || 0) < op.floor && hasFloor;
      const available = rows.filter(
        (r) =>
          r.source &&
          r.signal &&
          r.story &&
          r.ingested <= op.at &&
          r.embedded &&
          r.embedded <= op.at &&
          (r.source !== 'trend_hunter' || ['forward', 'reconcile'].includes(r.origin))
      );
      const potential = rows.filter((r) => available.includes(r) || r.representation === 'suppressed_native_receipt');
      const revisit = op.lane === 'revisit';
      const groupsKnown = !revisit || op[arm + '_groups_known'] === true;
      const unknownGroups = hasFloor && !groupsKnown && hasIndependentPair(potential, false);
      const canQualify = hasFloor && !replayFloor && groupsKnown && hasIndependentPair(available, revisit);
      const unknownEmbedding = hasFloor && groupsKnown && hasIndependentPair(potential, revisit) && potential.length > available.length;
      const reviewKey = key(op.id, arm);
      let judgment = judgments.get(reviewKey);
      if (judgment) {
        if (judgment.disposition === 'meets' && !canQualify)
          throw new Error('Insufficient available independent evidence or pool floor at this opportunity');
        judgment = judge(judgment, available, packet, movement, op);
        judgments.delete(reviewKey);
      }
      const disposition = unknownGroups ? 'unknown_revisit_groups' :
        judgment?.disposition ||
        (canQualify
          ? 'awaiting_review'
          : unknownEmbedding
            ? 'native_embedding_unknown'
            : replayFloor && available.length >= 2
              ? 'unknown_replay_dependent_floor'
              : 'below_gate');
      if (!first) {
        if (disposition === 'meets') first = { ...judgment, at: op.at, earlier_unknown: earlierUnknown };
        else if (
          ['uncertain', 'awaiting_review', 'native_embedding_unknown', 'unknown_replay_dependent_floor', 'unknown_revisit_groups'].includes(
            disposition
          )
        )
          earlierUnknown = true;
      }
      if (rows.length || judgment)
        packets.push({
          op: op.id,
          at: op.at,
          lane: op.lane,
          selected,
          floor: op.floor,
          disposition,
          review: judgment || null,
          evidence: rows,
        });
    }
    result[arm] = { first, packets };
  }
  if (judgments.size) throw new Error('Review refers to an unknown opportunity or arm');
  return result;
}

export function discoveryReport(packet, window, eligible, credit) {
  const candidates = new Map((packet.candidates || []).map((c) => [c.id, c]));
  const { frame, sample } = selectFrame([...candidates.values()], window, eligible, credit);
  const selected = new Set(sample.map((s) => s.id));
  const reviewed = new Map();
  for (const m of packet.movementReviews) {
    if (!selected.has(m.seed) || !m.reviewer || !m.reason || !m.candidates?.includes(m.seed))
      throw new Error('Review needs a sampled seed, movement membership, reviewer and rationale');
    for (const id of m.candidates) {
      if (!candidates.has(id) || reviewed.has(id)) throw new Error('Invalid or overlapping movement membership');
      reviewed.set(id, m);
    }
  }
  const byArm = Map.groupBy(packet.pools || [], (r) => key(r.op, r.arm));
  const opportunities = [...(packet.opportunities || [])].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
  );
  const results = [];
  for (const s of sample) {
    const review = reviewed.get(s.id);
    if (review && review.seed !== s.id) continue;
    const movement = { seed: s.id, candidates: [s.id], query: candidates.get(s.id).query, ...review };
    const comparison = compareMovement({ ...packet, opportunities }, movement, candidates, byArm, credit, window.cutoff);
    const { native, augmented } = comparison;
    const complete =
      native.first && augmented.first && !native.first.earlier_unknown && !augmented.first.earlier_unknown;
    const leftCensored = movement.candidates.some((id) => candidates.get(id).created < window.enabled);
    const paired = review && complete && !leftCensored;
    const estimated_lead_hours = paired
      ? (Date.parse(native.first.at) - Date.parse(augmented.first.at)) / 3600000
      : null;
    const disposition = !review
      ? 'awaiting_movement_review'
      : leftCensored
        ? 'predates_capture'
        : paired
          ? 'paired_estimate'
          : 'unknown_at_cutoff';
    results.push({
      ...s,
      seed: s.id,
      candidate_ids: movement.candidates,
      selected_seed_ids: movement.candidates.filter((id) => selected.has(id)),
      topic: candidates.get(s.id).topic,
      reviewer: review?.reviewer,
      reason: review?.reason,
      ...comparison,
      disposition,
      estimated_lead_hours,
      followup_hours: (Date.parse(window.cutoff) - Date.parse(candidates.get(s.id).created)) / 3600000,
    });
  }
  const leads = results
    .map((c) => c.estimated_lead_hours)
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  return {
    estimand:
      'First reviewed qualifying recorded pool for the same candidate movement in each arm. Native ranks and claim histories are conditional counterfactual estimates.',
    opportunity_start: opportunities[0]?.at || null,
    opportunity_end: opportunities.at(-1)?.at || null,
    opportunity_counts: Object.fromEntries(
      [...Map.groupBy(opportunities, (o) => o.lane)].map(([lane, items]) => [lane, items.length])
    ),
    seed,
    per_stratum: perStratum,
    frame,
    selected_seeds: sample.length,
    reviewed_movements: packet.movementReviews.length,
    paired: leads.length,
    unknown: results.length - leads.length,
    positive: leads.filter((n) => n > 0).length,
    zero: leads.filter((n) => n === 0).length,
    negative: leads.filter((n) => n < 0).length,
    median_estimated_lead_hours: leads.length
      ? (leads[Math.floor((leads.length - 1) / 2)] + leads[Math.floor(leads.length / 2)]) / 2
      : null,
    sample: results,
  };
}
