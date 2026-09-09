// Level 1 normalization for the scrape-gateway (CRMA-986, shape decided in
// CRMA-985).
//
// "Level 1" is the seam CRMA-985 chose between two rejected alternatives.
// Level 0 (hand the vendor's record through untouched) puts the vendor's
// schema in every ingester, so swapping a dataset edits every ingester.
// Level 2 (emit SIGNAL_ID / SIGNAL_TEXT / METADATA, ready for
// MERGE_EXTERNAL_SIGNALS) makes the gateway BE the ingester, deciding what
// counts as evidence text per platform — editorial judgment that is CRMA-1006's
// charter and out of this map's scope.
//
// So a normalized record is vendor-neutral but keeps its platform's own
// vocabulary: a TikTok record keeps `sound` and `share_count`, a Kickstarter
// record keeps `pledged` and `backers_count`. The gateway owns "what the
// vendor said, in our words". The ingester owns "what that means as a signal".
//
// TWO RULES CARRY THE DESIGN, and both exist to make scraper breakage LOUD.
//
// 1. Missing fields are nullable and never invented. The per-platform shape is
//    defined by what the decided route needs, not by what a vendor happens to
//    return. CRMA-985 rejected an intersection shape explicitly: adding a
//    weaker fallback vendor would then silently strip fields from the primary.
//
// 2. A record missing a REQUIRED field is dropped and counted, never passed on
//    half-built. This is the stronger argument for normalizing at all. Under
//    passthrough a renamed vendor field hands `undefined` downstream and the
//    ingester writes signals with empty text — a silent quality failure that
//    surfaces days later as trends with no evidence. A non-zero `rejected`
//    count makes the same breakage loud at the moment it happens, and is the
//    material CRMA-989 builds its freshness alerting on.
//
// One bad record never fails the whole job: a partial pull beats no pull.

/**
 * The required fields per platform — the fields whose absence means the
 * record cannot do the job its route decision gave it.
 *
 * TikTok (CRMA-983): description + sound + engagement + public URL were what
 * cleared the reopen condition against the #18 specificity rubric, so all four
 * are load-bearing rather than nice-to-have.
 *
 * Reddit (CRMA-982): post-level records need their text and a verifiable URL;
 * score and comment count are the velocity material the re-poll delta reads.
 *
 * Kickstarter (CRMA-984): the signal IS the first sighting of a project id, so
 * the id and URL are required; `raised_pct` carries the traction gate.
 */
export const REQUIRED_FIELDS = {
  tiktok: ["post_id", "url", "description", "sound"],
  reddit: ["post_id", "url", "title", "subreddit"],
  kickstarter: ["project_id", "url", "title"],
};

/**
 * Normalize one vendor payload into a platform-shaped record set, dropping
 * and counting anything that cannot satisfy REQUIRED_FIELDS.
 *
 * The per-record mapper is supplied by the caller — it is the (platform,
 * vendor) normalizer CRMA-985 keys by, e.g. normalize/tiktok_brightdata.mjs.
 * Keeping the mapper out of here is what makes an Apify fallback a sibling
 * file rather than an edit: this validation and counting is shared, and only
 * the field mapping differs per vendor.
 *
 * @param {object} args
 * @param {string} args.platform          one of REQUIRED_FIELDS' keys
 * @param {unknown[]} args.rawRecords     the vendor's records, as returned
 * @param {(raw: object) => object} args.map  vendor record -> platform record
 * @returns {{records: object[], rejected: number, reject_reasons: object}}
 */
export function normalizeRecords({ platform, rawRecords, map }) {
  const required = REQUIRED_FIELDS[platform];
  if (!required) throw new Error(`no record shape defined for platform: ${platform}`);

  const records = [];
  const reject_reasons = {};
  let rejected = 0;

  const reject = (reason) => {
    rejected += 1;
    reject_reasons[reason] = (reject_reasons[reason] ?? 0) + 1;
  };

  for (const raw of rawRecords ?? []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      reject("not_an_object");
      continue;
    }

    let record;
    try {
      record = map(raw);
    } catch (err) {
      // A mapper that throws is a bug OR a vendor payload shaped differently
      // enough to break field access. Either way it is one record's problem,
      // and the reason string is capped so a message carrying record data
      // cannot blow up the reject_reasons histogram into unbounded keys.
      reject(`mapper_error: ${String(err?.message ?? err).slice(0, 80)}`);
      continue;
    }

    // Report EVERY missing required field, not just the first. A vendor that
    // renames one field and a vendor that returns an empty husk look identical
    // under first-failure reporting, and they need different responses.
    const missing = required.filter((f) => isBlank(record?.[f]));
    if (missing.length) {
      reject(`missing:${missing.join(",")}`);
      continue;
    }

    records.push(record);
  }

  return { records, rejected, reject_reasons };
}

// Empty string and whitespace count as missing. A scraper that breaks part-way
// very often returns the key with an empty value rather than dropping it, and
// treating that as present is exactly the silent failure this module exists to
// prevent. `0` and `false` are genuine values and stay.
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}
