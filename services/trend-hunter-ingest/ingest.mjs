import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const apiRoot = 'https://nxt.trendhunter.com/api/integrations/tie-signals/v1/';

export function utc(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) ? time.toISOString() : null;
}

export function createProvider({apiKey, fetchImpl = fetch}) {
  if (!apiKey?.trim()) throw new Error('Missing TREND_HUNTER_ARTICLES_API_KEY');
  async function request(url) {
    const response = await fetchImpl(url, {headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'},
      redirect: 'error', signal: AbortSignal.timeout(60000)});
    if (!response.ok) {
      const error = new Error(`Trend Hunter HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    return response.json();
  }
  return {
    fetchPage({from, to, cursor}) {
      const url = new URL('articles', apiRoot);
      url.search = new URLSearchParams({status: 'accepted', from, to, sort: 'oldest', limit: '100', fields: '-text'});
      if (cursor !== null) url.searchParams.set('cursor', cursor);
      return request(url);
    },
    async fetchDetail(id) {
      const result = await request(new URL('articles/' + encodeURIComponent(id), apiRoot));
      const detail = result?.data ?? result;
      if (String(detail?.id) !== String(id)) throw new Error('Mismatched Trend Hunter article detail');
      return detail;
    },
  };
}

function wireOriginal(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\bView (?:the )?original (?:content|release)(?: to download multimedia)?\s*:\s*(https?:\/\/[^\s<>"']+)/i);
  if (!match) return null;
  const url = URL.parse(match[1].replace(/[).,;]+$/, ''));
  const host = url?.hostname.toLowerCase().replace(/^www\./, '');
  if (!url || url.username || url.password) return null;
  if (['prnewswire.com', 'prnewswire.co.uk', 'prnewswire.co.in'].includes(host) &&
      /^\/news-releases\/.+-\d{9}\.html$/.test(url.pathname)) return url.href;
  if (host === 'businesswire.com' && /^\/news\/home\/\d{12,}\//.test(url.pathname)) return url.href;
  if (host === 'globenewswire.com' && /^\/news-release\/\d{4}\/\d{2}\/\d{2}\/\d+\//i.test(url.pathname)) return url.href;
  return null;
}

async function releaseProof(article, fetchDetail, cachedProof) {
  const original = wireOriginal(article.summary);
  if (original) return {original_url: original};
  if (article.text_kind !== 'full' || !/PR\s*Newswire|Business\s*Wire|Globe\s*Newswire|press release|syndicat/i.test(
    [article.source, article.url, article.summary, article.title].join(' '))) return null;
  const read = () => detailProof(String(article.id), fetchDetail);
  return cachedProof ? cachedProof(String(article.id), read) : read();
}

async function detailProof(id, fetchDetail) {
  let detail;
  try {
    detail = await fetchDetail(id);
  } catch (error) {
    if (error.status === 404 || error.status === 410) return null;
    throw error;
  }
  if (detail.status !== 'accepted' || detail.text_kind !== 'full' || typeof detail.text !== 'string') return null;
  const originalUrl = wireOriginal(detail.text);
  if (originalUrl) return {original_url: originalUrl};
  const body = detail.text.normalize('NFC').trim().replace(/\s+/g, ' ');
  // A full wire dateline distinguishes an identical release from repeated summaries or publisher boilerplate.
  if (body.length < 300 || !/\/PRNewswire\/|\(BUSINESS WIRE\)|\(GLOBE NEWSWIRE\)/i.test(body)) return null;
  return {text_sha256: createHash('sha256').update(body).digest('hex')};
}

async function signalFor(raw, observed, origin, from, to, fetchDetail, windowId, pageNumber, cachedProof) {
  const article = raw && typeof raw === 'object' ? raw : {};
  const providerId = ['number', 'string'].includes(typeof article.id) ? String(article.id).trim() || null : null;
  const original = typeof article.url === 'string' ? article.url.trim() : null;
  const url = original ? URL.parse(original) : null;
  const validUrl = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    (url.pathname !== '/' || url.search);
  const title = typeof article.title === 'string' ? article.title.trim() : '';
  const firstSeen = utc(article.first_seen);
  const published = utc(article.published_at);
  const summary = typeof article.summary === 'string' ? article.summary.trim() : '';
  let reason = null;
  if (article.status !== 'accepted') reason = 'missing_status';
  else if (!providerId) reason = 'missing_provider_id';
  else if (!validUrl) reason = 'invalid_original_url';
  else if (!title) reason = 'missing_headline';
  else if (!firstSeen) reason = 'invalid_first_seen';
  else if (firstSeen < from || firstSeen >= to) reason = 'outside_window';
  else if (article.published_at != null && !published) reason = 'invalid_published_at';

  const metadata = {
    observation_key: providerId ? `id:${providerId}` : `invalid:${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`,
    provider_id: providerId, original_url: url?.username || url?.password ? null : original,
    publisher: validUrl ? url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') : null,
    feed_label: article.source ?? null, status: article.status ?? null, verdict: article.verdict ?? null,
    published_at_utc: published, first_seen_utc: firstSeen, first_observed_at_utc: observed, origin,
    signal_kind: 'discovery_signal', unusable_reason: reason, window_id: windowId, page_number: pageNumber,
  };
  if (!reason) {
    const proof = await releaseProof(article, fetchDetail, cachedProof);
    if (proof) metadata.release_proof = proof;
  }
  return {SOURCE_NAME: 'trend_hunter', SIGNAL_ID: reason ? null : original, URL: metadata.original_url,
    SIGNAL_TIMESTAMP: published ?? firstSeen, SIGNAL_TITLE: title || null, SIGNAL_TEXT: summary || title || null,
    METADATA: JSON.stringify(metadata)};
}

export function validatePage(page) {
  if (!Array.isArray(page?.data) || !(page.next_cursor === null || (typeof page.next_cursor === 'string' && page.next_cursor))) {
    throw new Error('Invalid article page or missing next_cursor');
  }
}

export async function preparePage({data, observed, from, to, origin, fetchDetail, windowId, pageNumber, cachedProof}) {
  let accepted = 0;
  const signals = [];
  for (const article of data) {
    if (article?.status && article.status !== 'accepted') continue;
    if (article?.status === 'accepted') accepted++;
    signals.push(await signalFor(article, observed, origin, from, to, fetchDetail, windowId, pageNumber, cachedProof));
  }
  return {signals, accepted};
}

export async function withArticleRuntime(env, run) {
  const provider = createProvider({apiKey: env.TREND_HUNTER_ARTICLES_API_KEY});
  for (const name of ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PRIVATE_KEY']) {
    if (!env[name]?.trim()) throw new Error('Missing ' + name);
  }
  const {default: snowflake} = await import('snowflake-sdk');
  snowflake.configure({logLevel: 'ERROR'});
  const conn = snowflake.createConnection({
    account: env.SNOWFLAKE_ACCOUNT, username: env.SNOWFLAKE_USER, authenticator: 'SNOWFLAKE_JWT',
    privateKey: env.SNOWFLAKE_PRIVATE_KEY.replace(/\\n/g, '\n'), role: env.SNOWFLAKE_ROLE || 'MARKETING_ENGINEER',
    warehouse: env.SNOWFLAKE_WAREHOUSE || 'MARKETING_WH', database: 'MCC_RAW', schema: 'MARKETING_DEV',
  });
  await new Promise((resolve, reject) => conn.connect(err => err ? reject(err) : resolve()));
  const query = (sqlText, binds = []) => new Promise((resolve, reject) => {
    conn.execute({sqlText, binds, complete: (err, stmt, rows) => err ? reject(err) : resolve(rows)});
  });
  try {
    return await run({...provider, query});
  } finally {
    await new Promise(resolve => conn.destroy(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import('./job.mjs').then(({runJob}) => withArticleRuntime(process.env, runtime => runJob(process.env, runtime)))
    .then(counts => console.log(JSON.stringify(counts)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
