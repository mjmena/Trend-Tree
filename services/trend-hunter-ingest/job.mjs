import {randomUUID} from 'node:crypto';
import {preparePage, utc, validatePage} from './ingest.mjs';

function warehouse(query) {
  return async (action, args) => {
    const [row] = await query('CALL MCC_RAW.MARKETING_DEV.TREND_HUNTER_INTAKE(?)', [JSON.stringify({action, ...args})]);
    const result = row?.TREND_HUNTER_INTAKE;
    if (!result) throw new Error('Missing Trend Hunter intake result');
    return typeof result === 'string' ? JSON.parse(result) : result;
  };
}

function articleMetadata(rows) {
  const fields = ['id', 'status', 'verdict', 'url', 'source', 'title', 'summary', 'text_kind', 'first_seen', 'published_at'];
  return rows.filter(row => !row?.status || row.status === 'accepted').map(row => {
    if (!row || typeof row !== 'object') return null;
    const stored = Object.fromEntries(fields.filter(key => key in row).map(key => [key, row[key]]));
    const url = typeof stored.url === 'string' ? URL.parse(stored.url) : null;
    if (url?.username || url?.password) stored.url = null;
    return stored;
  });
}

class RateLimited extends Error {
  constructor(retryAt) {
    super('Provider cooldown until ' + retryAt);
    this.retryAt = retryAt;
  }
}

function providerRequest(call, now, sleep) {
  return async (fetchMethod, input) => {
    for (let retry = 0; ; retry++) {
      let gate = await call('gate');
      while (gate.retry_at && Date.parse(gate.retry_at) > now().getTime()) {
        const delay = Date.parse(gate.retry_at) - now().getTime();
        if (delay > 30000 || retry >= 3) throw new RateLimited(gate.retry_at);
        await sleep(delay);
        gate = await call('gate');
      }
      try {
        return await fetchMethod(input);
      } catch (error) {
        if (error.status !== 429 && !(error.status === 503 && error.retryAfter)) throw error;
        const current = now().getTime();
        const header = error.retryAfter?.trim();
        const deadline = /^\d+$/.test(header) ? current + Number(header) * 1000 : Date.parse(header);
        const retryAt = new Date(Number.isFinite(deadline) && deadline > current ? deadline : current + 1000 * 2 ** retry).toISOString();
        await call('cooldown', {retry_at: retryAt});
        if (retry >= 2) throw new RateLimited(retryAt);
      }
    }
  };
}

export async function runJob(env, {query, intake = warehouse(query), fetchPage, fetchDetail, now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const execution = env.CLOUD_RUN_EXECUTION || randomUUID();
  const attempt = String(env.CLOUD_RUN_TASK_ATTEMPT || '0');
  const origin = env.TREND_HUNTER_ORIGIN || (env.TREND_HUNTER_FROM || env.TREND_HUNTER_TO ? 'replay' : 'forward');
  let from, to;
  if (origin === 'replay') {
    from = utc(env.TREND_HUNTER_FROM);
    to = utc(env.TREND_HUNTER_TO);
    if (!from || !to || from >= to || Date.parse(to) > now().getTime() || Date.parse(to) - Date.parse(from) > 7 * 86400000) {
      throw new Error('Replay requires explicit increasing past bounds with offsets, at most seven days apart');
    }
  } else if (!['forward', 'reconcile'].includes(origin) || env.TREND_HUNTER_FROM || env.TREND_HUNTER_TO) {
    throw new Error('Use forward or reconcile without bounds, or replay with both bounds');
  }
  const call = (action, args = {}) => intake(action, {execution, attempt, ...args});
  const request = providerRequest(call, now, sleep);
  const token = randomUUID();
  let state = await call('open', {origin, from, to, now: now().toISOString()});
  let outcome = state.id ? 'complete' : 'current';
  let retryAt;
  try {
    while (!state.complete && state.id) {
      const {id, page_number, from, to, cursor} = state;
      if (!state.receipt) {
        state = await request(async () => {
          const claim = await call('claim', {id, page_number, token});
          if (!claim.claimed) return claim;
          const page = await fetchPage({from, to, cursor});
          const observed = now().toISOString();
          validatePage(page);
          return call('receive', {id, page_number, token, data: articleMetadata(page.data), next_cursor: page.next_cursor, observed});
        });
        if (state.busy) {
          outcome = 'in_progress';
          break;
        }
        continue;
      }
      const cachedProof = async (providerId, read) => {
        const key = {id, page_number, provider_id: providerId};
        const cached = await call('proof', key);
        if (cached.found) return cached.proof;
        const saved = await call('save_proof', {...key, proof: await read()});
        return saved.proof;
      };
      const prepared = await preparePage({cachedProof,data: state.receipt.data, observed: state.receipt.observed,
        from, to, origin: state.origin, windowId: id, pageNumber: page_number, fetchDetail: articleId => request(fetchDetail, articleId)});
      state = await call('commit', {id, page_number, ...prepared});
    }
  } catch (error) {
    if (!(error instanceof RateLimited)) {
      await call('finish', {outcome: 'failed', id: state.id, token});
      throw error;
    }
    outcome = 'rate_limited';
    retryAt = error.retryAt;
  }
  await call('finish', {outcome, id: state.id, token});
  return {execution, window_id: state.id ?? null, origin, from: state.from, to: state.to,
    outcome, pages: state.page_number ?? 0, ...state.counts, ...(retryAt && {retry_at: retryAt})};
}
