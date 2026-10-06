// (kickstarter, brightdata) normalizer — CRMA-986, keyed per CRMA-985.
//
// THIS FILE'S FIELD NAMES ARE UNVERIFIED, and unlike the other two normalizers
// that cannot be fixed by reading better docs.
//
// Kickstarter is not a Bright Data dataset. CRMA-984 routed it through Web
// Unlocker against Kickstarter's OWN discover/advanced JSON surface, so the
// shape below is Kickstarter's, not a vendor's. Researched 2026-09-07:
//
//   * Kickstarter's only documented public API is its STATUS page API
//     (incidents and components). It documents no project search or discovery.
//   * The former public v1 OAuth API was closed to new applications years ago
//     and has no current public schema.
//   * Everything known about `/discover/advanced?format=json` — a top-level
//     `projects` array with `total_hits`, and per-project `id`, `name`,
//     `blurb`, `pledged`, `goal`, `percent_funded`, `backers_count`, `state`,
//     `category`, `launched_at`, `deadline`, `urls.web.project` — comes from
//     COMMUNITY REVERSE-ENGINEERING (third-party scrapers, the webrobots.io
//     monthly dumps). No primary source confirms any of it.
//
// A LIVE RESPONSE IS THE ONLY THING THAT SETTLES THIS, which is CRMA-986's
// gate check 2. There is a specific reason to doubt the route as decided: some
// scraper vendors extract Kickstarter project JSON from an HTML data attribute
// (`div.js-react-proj-card[data-project]`) rather than from a `format=json`
// response, which suggests `format=json` may not be universally available or
// stable. If gate check 2 comes back with HTML instead of JSON, the problem is
// CRMA-984's ROUTE, not Turnstile, and that decision reopens.
//
// Until then this normalizer is a best-effort mapping whose wrongness is
// designed to be loud: any field it guesses wrong rejects the record as
// `missing:<field>` in scrape_normalize.mjs rather than emitting a half-built
// signal. Read a non-zero `rejected` count on the first live pull as a schema
// correction to make here, not as a scraper failure.

// Read a dotted path without throwing on a missing intermediate. The project
// URL is nested (`urls.web.project`) in every community description of this
// payload, and a flat access would throw on the first record.
function path(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return cur ?? null;
}

/**
 * @param {object} raw one project object from Kickstarter's discover payload
 * @returns {object} the platform-shaped record
 */
export function normalizeKickstarterBrightData(raw) {
  // CRMA-984 made "first sighting of a project id" the signal itself, so the
  // id is the single most load-bearing field in this record: dedupe in the
  // STG_EXTERNAL_SIGNALS MERGE keys on a SIGNAL_ID derived from it. A wrong id
  // field would not fail loudly — it would re-emit every project on every
  // pull — so it is required, and it is checked first.
  const project_id = raw.id ?? raw.project_id ?? null;

  return {
    project_id: project_id === null ? null : String(project_id),
    url: path(raw, "urls.web.project") ?? raw.url ?? null,
    title: raw.name ?? raw.title ?? null,
    blurb: raw.blurb ?? null,

    // The traction gate. CRMA-984 gates on state=live plus a funded bucket,
    // and requires gate check 2 to confirm the raised filter survives the
    // vendor route — if it does not, that decision falls back to re-poll
    // diffing. `percent_funded` is the field that would carry it.
    pledged: raw.pledged ?? null,
    goal: raw.goal ?? null,
    percent_funded: raw.percent_funded ?? null,
    backers_count: raw.backers_count ?? null,
    state: raw.state ?? null,

    // Community descriptions show `category` as an object, but a flat string
    // is plausible enough to be worth handling rather than mangling.
    category: typeof raw.category === "string" ? raw.category : path(raw, "category.name"),

    launched_at: raw.launched_at ?? null,
    deadline: raw.deadline ?? null,

    raw,
  };
}
