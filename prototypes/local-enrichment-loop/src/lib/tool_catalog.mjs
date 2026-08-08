// PROTOTYPE (CRMA-438) — tool schemas ported verbatim from
// enrichment-p_xMC995w/run_enrichment_agent/entry.js (canonical:
// agents/lib/tool_catalog.mjs scoped to enrichment).

const QUERY_SCHEMAS = {
  query_trend_neighbors: {
    name: "query_trend_neighbors",
    description:
      "Find trends near (in topic-overlap) the trend currently being enriched. Use BEFORE finalizing category/subcategory to sanity-check that you're not categorizing this trend differently from highly-similar neighbors without specific reason. Returns trend_id, trend_topic, total_cluster_size, velocity_direction, trend_heat_index, similarity_score, plus the neighbor's existing category + subcategory + trend_name (the canonical singular name post-2026-05-27 cutover, falls back to legacy B2C if not yet re-enriched). Use the returned trend_name list to enforce neighbor_non_overlap — your new name must not be interchangeable with any neighbor's. Operates on a pre-fetched pool of recent active trends; uses Jaccard token overlap for similarity (Phase 1 — no live embeddings).",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Free-text topic to match against (use the trend's noun-verb description)." },
        k: { type: "integer", description: "Number of neighbors to return (default 5, max 15)." },
        min_similarity: { type: "number", description: "Optional Jaccard cutoff 0.0-1.0 (default 0.0)." },
      },
      required: ["topic"],
    },
  },
  query_trend_metrics: {
    name: "query_trend_metrics",
    description:
      "Look up full metadata for one or more existing trend ids returned by query_trend_neighbors. Returns TREND_TOPIC, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT, VELOCITY_DIRECTION, TREND_HEAT_INDEX, LAST_UPDATE_AT, plus existing CATEGORY/SUBCATEGORY/SUMMARY_SHORT/TREND_NAME if enriched.",
    input_schema: {
      type: "object",
      properties: {
        trend_ids: { type: "array", items: { type: "string" }, description: "One or more trend UUIDs from query_trend_neighbors." },
      },
      required: ["trend_ids"],
    },
  },
  query_trend_source_metrics: {
    name: "query_trend_source_metrics",
    description:
      "Look up FCT_TREND_SOURCE_METRICS rows for the trend currently being enriched. Returns one entry per source (gdelt, wikimedia, bluesky, google_trends, amazon, pinterest, tiktok) with headline_metric, headline_metric_name, and the full metrics VARIANT. Reads from a context-provided pool — pre-fetched, not live SQL.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Optional source filter (e.g. 'gdelt')." },
        min_headline_metric: { type: "number", description: "Optional: only return sources with headline_metric >= this value." },
      },
    },
  },
  validate_url_canonical: {
    name: "validate_url_canonical",
    description:
      "Resolve a URL to its canonical form via HEAD request + redirect chase. Returns canonical_url, status, content_type. Use to verify ANY URL before citing it in social_proof, voice_of_customer, or social_narrative — drop URLs that 404 or redirect to login/captcha walls. Times out at 5s per URL.",
    input_schema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "One or more URLs to verify (max 10 per call)." },
      },
      required: ["urls"],
    },
  },
};

const INGEST_SCHEMAS = {
  ingest_search_bluesky: {
    name: "ingest_search_bluesky",
    description:
      "Search Bluesky (ATProto) for posts matching a query. Returns up to `limit` posts with author handle, text snippet, like + repost counts, embedded URL, created_at, and `url` (the canonical bsky.app post permalink). Latency ~6-8s. PRIMARY tool for voice_of_customer quotes and live cultural language for naming. When citing a Bluesky post as evidence, use the returned `url` verbatim — never build a post URL from signal_id or author_handle (those are not valid rkeys and 404).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Specific multi-word phrase, not a single broad word." },
        limit: { type: "integer", description: "Max posts (default 25, max 100)." },
        sort: { type: "string", enum: ["latest", "top"], description: "Default 'latest'." },
      },
      required: ["query"],
    },
  },
  ingest_search_gdelt: {
    name: "ingest_search_gdelt",
    description:
      "Search GDELT global news index for articles matching a topic. Returns up to ~150 articles with title, domain, url, published_at, language, tone. Latency ~20-30s due to GDELT rate limits. Use for hard-news corroboration of social_proof items.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "GDELT-syntax query (quotes, OR, NEAR/N supported)." },
        window_days: { type: "integer", description: "Days back from today (default 7, max 30)." },
        mode: { type: "string", enum: ["ArtList", "ArtRecent"], description: "Default ArtList (relevance-ranked)." },
      },
      required: ["topic"],
    },
  },
  ingest_search_google_trends: {
    name: "ingest_search_google_trends",
    description:
      "Look up Google Trends interest + related queries for a keyword. Latency ~30-50s (rate-limited). Use sparingly. Useful for confirming search-volume momentum.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        geo: { type: "string", description: "ISO country code (default 'US')." },
        timeframe: { type: "string", description: "Default 'now 7-d'." },
      },
      required: ["keyword"],
    },
  },
  ingest_grok_live_search: {
    name: "ingest_grok_live_search",
    description:
      "Search X (Twitter) for live posts about a query via Grok's x_search. Returns {summary, citations: [{url, context, handle}]} — 3-8 real X posts (x.com/<handle>/status) with a one-sentence context each. The X/social grounding tool for voice-of-customer and what named accounts are saying. For web/news use ingest_search_gdelt.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
};

const ATOMIC_QUERY_RULE =
  "A single atomic, consumer-vernacular search term — the ingredient, " +
  "product, or practice a shopper would actually type into a search box. " +
  "NOT the compound behavior, NOT a coined marketing label, NOT industry " +
  "jargon (e.g. 'retailtainment', 'agentic commerce'), and NOT a fresh " +
  "internet-slang neologism that catalogs lag on (e.g. '-maxxing' coinages). " +
  "Prefer the established noun a category already has over a clever phrase. " +
  "This is a join key to external keyword APIs (Exploding Topics, Google " +
  "Trends) — it is graded on whether those catalogs recognize it, so reach " +
  "for the plainest term that still names THIS trend specifically.";

const STATEMENT_RULE =
  "A tight 2-4 sentence faithful prose core in a machine register: the " +
  "subject, the specific behavior/product (the noun a consumer can put on a " +
  "slide and the verb they are doing), the distinguishing axis vs. sibling " +
  "trends, and the domain. De-buzzworded — no marketing flavor, no " +
  "call-to-action, not action-oriented copy. This is consumed by other " +
  "systems (the trend embedding, external APIs), not by a human reader.";

const DESCRIPTOR_TOOL_PROPERTIES = {
  descriptor: {
    type: "object",
    description:
      "Machine-facing canonical artifact (ADR-0003). NOT a summary, NOT the name — the de-buzzworded soul of the trend, authored for other systems.",
    properties: {
      statement: { type: "string", description: STATEMENT_RULE },
      query: { type: "string", description: ATOMIC_QUERY_RULE },
    },
    required: ["statement", "query"],
  },
  specificity_score: {
    type: "number",
    description:
      "Self-predicted 0.0-1.0 (1.0 = crisp noun-verb-product, 0.0 = bare category). Telemetry on how specific this trend is — no gate acts on it.",
  },
};

const DESCRIPTOR_REQUIRED_FIELDS = ["descriptor", "specificity_score"];

const ENRICHMENT_SCHEMAS = {
  propose_enrichment: {
    name: "propose_enrichment",
    description:
      "Emit the final enrichment record for this trend. Call this exactly ONCE near the end of the loop after gathering evidence, drafting candidate names with self-critique, validating cited URLs, and finalizing the trend profile. The tool's input schema is the canonical DIM_TREND_ENRICHMENT shape — populate every field that applies. Calling this is what causes the workflow to persist anything; if you don't call it, nothing is written.",
    input_schema: {
      type: "object",
      properties: {
        trend_name: { type: "string", description: "2-8 words preferred (no hard cap). Singular human-facing name. Must pass decode_pass — a strategist seeing only this name (no topic, no context) must be able to identify the trend's core subject. First-beat noun MUST NOT be a category-of-change word (architecture, maximalism, minimalism, wellness, modernism, movement, era, wave, mode, aesthetic, vibe, paradigm, philosophy). See the NAMING GUIDANCE block in the system prompt for the full rule." },
        summary_short: { type: "string", description: "1-2 sentences, action-oriented." },
        summary_long: { type: "string", description: "1 paragraph (≤500 chars), action-oriented." },
        category: { type: "string", enum: ["wellness", "food_beverage", "beauty", "fitness", "fashion", "home_living", "sustainability", "consumer_tech", "personal_care", "social_lifestyle", "entertainment", "travel", "parenting", "other"] },
        subcategory: { type: "string", description: "Lowercase snake_case." },
        category_confidence: { type: "number", description: "0.0-1.0; set <0.6 if you genuinely couldn't fit a category." },
        social_narrative: {
          type: "array",
          items: {
            type: "object",
            properties: {
              point: { type: "string" },
              evidence_url: { type: "string" },
            },
            required: ["point"],
          },
          description: "3-5 narrative points explaining why this is happening now.",
        },
        cultural_drivers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              driver: { type: "string" },
              influence_level: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["driver", "influence_level"],
          },
        },
        seasonal_relevance: {
          type: "object",
          properties: {
            is_seasonal: { type: "boolean" },
            peak_months: { type: "array", items: { type: "string" } },
          },
          required: ["is_seasonal"],
        },
        geographic_hotspots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              region: { type: "string" },
              intensity: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["region", "intensity"],
          },
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "Click-through URL — required." },
              type: { type: "string", enum: ["news", "social", "commerce", "reference", "search_volume", "video", "other"], description: "What kind of link this is." },
              source: { type: "string", description: "Outlet, handle, or retailer (e.g. 'Forbes', '@xyz', 'Amazon')." },
              claim: { type: "string", description: "One-line description of what this evidence shows." },
              captured_at: { type: "string", description: "ISO timestamp." },
              quote: { type: "string", description: "Verbatim post text — populate when type=social with a real quote." },
              engagement: {
                type: "object",
                properties: {
                  likes: { type: "number" },
                  reposts: { type: "number" },
                },
                description: "Optional Bluesky/X engagement counts.",
              },
            },
            required: ["url", "type", "source", "claim", "captured_at"],
          },
          description: "Typed pool of links — both pre-fetched signals you reference AND new tool-found links. Tag every entry with the right `type`. Aim for diversity (e.g. 2 news + 2 social w/ quotes + 1 commerce).",
        },
        name_candidates_considered: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              scores: {
                type: "object",
                properties: {
                  distinctiveness: { type: "number", description: "0-10, would this stand out next to 5 other trends in the same category?" },
                  specificity:     { type: "number", description: "0-10, is it specific to THIS trend (not generic to the category)?" },
                  decode_score:    { type: "number", description: "0-10, if a strategist saw ONLY this name (no topic, no context), would they correctly identify the trend's core subject? Floor: 7." },
                },
              },
            },
            required: ["name", "scores"],
          },
          description: "All 10 single-audience candidates with per-axis 0-10 scores. Required for naming-quality audit. Drop the legacy audience field — singular name per trend post-2026-05-27 cutover.",
        },
        reasoning: { type: "string", description: "≤500 chars on why this name + categorization fit." },
        ...DESCRIPTOR_TOOL_PROPERTIES,
      },
      required: ["trend_name", "summary_short", "summary_long", "category", "subcategory", "category_confidence", "evidence", "name_candidates_considered", "reasoning", ...DESCRIPTOR_REQUIRED_FIELDS],
    },
  },
};

const META_SCHEMAS = {
  discover_external_tools: {
    name: "discover_external_tools",
    description:
      "Surface schemas of additional tools (web/social/search). Use when you need to gather external evidence and the tool isn't already in your toolbox. Returns the JSON schemas matching `need`; call them by name afterward.",
    input_schema: {
      type: "object",
      properties: {
        need: {
          type: "string",
          enum: ["social", "web", "search", "cultural", "competitive", "all"],
          description: "social → Bluesky; cultural → Bluesky+Grok; search → GDELT+Google Trends+Grok; competitive → Grok+GDELT; all → everything.",
        },
      },
      required: ["need"],
    },
  },
};

export const ALL_SCHEMAS = { ...QUERY_SCHEMAS, ...INGEST_SCHEMAS, ...ENRICHMENT_SCHEMAS, ...META_SCHEMAS };

// All tools registered eagerly. Gemini's functionDeclarations require tools
// to be declared upfront — deferred loading via discover_external_tools
// doesn't work across API boundaries the way it does with Anthropic.
export const EAGER_TOOL_NAMES = [
  "query_trend_neighbors",
  "query_trend_metrics",
  "query_trend_source_metrics",
  "validate_url_canonical",
  "discover_external_tools",
  "propose_enrichment",
  "ingest_search_bluesky",
  "ingest_search_gdelt",
  "ingest_search_google_trends",
  "ingest_grok_live_search",
];

export const DEFERRED_BY_NEED = {
  social: ["ingest_search_bluesky", "ingest_grok_live_search"],
  web: ["ingest_search_google_trends", "ingest_search_gdelt"],
  search: ["ingest_search_gdelt", "ingest_search_google_trends"],
  cultural: ["ingest_search_bluesky", "ingest_grok_live_search"],
  competitive: ["ingest_search_gdelt", "ingest_search_google_trends"],
  all: ["ingest_search_bluesky", "ingest_search_gdelt", "ingest_search_google_trends", "ingest_grok_live_search"],
};

export function toFunctionDeclarations(toolNames) {
  return toolNames.map((n) => {
    const s = ALL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return { name: s.name, description: s.description, parameters: s.input_schema };
  });
}
