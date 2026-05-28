// Shared agent tool catalog
// =========================
//
// Single source of truth for tool schemas + dispatchers used by the
// distillation lead and subagent (and, eventually, Phase 2 enrichment +
// Phase 3 lifecycle agents). Each tool exposes:
//
//   - an Anthropic-API tool definition (name, description, input_schema)
//   - an async invoker function dispatch(name, input, context) -> any
//
// The `context` object passed to dispatch() contains everything the tool
// needs that wasn't in `input`: pre-fetched Snowflake rows, HTTP endpoint
// URLs, session ids, the anthropic auth, etc. This keeps the catalog
// stateless and re-usable across workflows.
//
// CONSTRAINT (Pipedream gotcha #1): custom-code steps cannot run
// Snowflake queries directly. So `query_*` tools are LOOKUPS against
// data pre-fetched by upstream workflow.yaml steps, not live SQL. If a
// future tool genuinely needs ad-hoc SQL, wrap it as a separate
// HTTP-triggered workflow and add it as an `ingest_*`-style HTTP tool.
//
// Tool taxonomy:
//   EAGER (loaded at every loop start) — cheap to advertise, used often:
//     query_signals_window, query_louvain_candidates,
//     query_trend_neighbors, query_trend_metrics,
//     validate_dedupe_pair, validate_url_canonical
//
//   DEFERRED (loaded only when discover_external_tools surfaces them):
//     ingest_search_bluesky, ingest_search_gdelt,
//     ingest_search_google_trends, ingest_grok_live_search,
//     decide_consult_grok, decide_consult_gemini  (Phase 2; stubs only)
//
//   LEAD-ONLY (the lead orchestrator gets these; subagents do not):
//     dispatch_subagent, propose_trend_candidate
//
//   The discover_external_tools meta-tool is itself eager and returns the
//   schemas of whichever deferred tools match the `need` argument.

import { fanoutSubagents } from "./subagent_client.mjs";

// ────────────────────────────────────────────────────────────────────────
// Tool schemas (Anthropic tool-use format)
// ────────────────────────────────────────────────────────────────────────

const QUERY_SCHEMAS = {
  query_signals_window: {
    name: "query_signals_window",
    description:
      "Filter the pre-fetched signal window (recent unclustered/clustered signals from STG_EXTERNAL_SIGNALS) by source, domain, time window, or full-text match against title/body. Returns up to `limit` signal records with id, title, source, domain, detected_at, and a snippet. Use this to scan the firehose, find specific patterns, or look up a specific signal by id. Note: this tool reads from a context-provided pool, not live Snowflake.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Optional source filter: gdelt | bluesky | tiktok | reddit | google_trends | wikimedia | amazon | pinterest. Omit to span all sources.",
        },
        domain_contains: {
          type: "string",
          description: "Optional substring match against signal domain (e.g. 'reddit.com', 'wsj').",
        },
        text_contains: {
          type: "string",
          description:
            "Optional case-insensitive substring match against signal title and body.",
        },
        signal_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of signal UUIDs to look up directly.",
        },
        limit: {
          type: "integer",
          description: "Max signals to return (default 25, hard cap 100).",
        },
      },
    },
  },

  query_louvain_candidates: {
    name: "query_louvain_candidates",
    description:
      "Return the SQL clustering's view of the same signal window, as a list of candidate clusters. Each cluster comes with cluster_id, centroid_topic (LLM-generated topic name from proc_cluster_trends), signal_ids, signal_count, distinct_source_count, and top_domains. Use this to (a) cross-reference your raw-signal hypotheses against the embedding math, (b) discover Louvain-only clusters you missed in your scan, and (c) inspect Louvain clusters that look too broad for splitting.",
    input_schema: {
      type: "object",
      properties: {
        min_signal_count: {
          type: "integer",
          description: "Filter to clusters with at least this many signals (default 3).",
        },
        contains_signal_id: {
          type: "string",
          description: "Optional: return only the cluster containing this signal id.",
        },
      },
    },
  },

  query_trend_neighbors: {
    name: "query_trend_neighbors",
    description:
      "Find the k existing trends closest to a candidate topic or signal cluster. Returns trend_id, trend_topic, total_cluster_size, velocity_direction, trend_heat_index, and similarity_score (cosine). Use this BEFORE writing a new candidate to check whether the pattern is actually a duplicate or significant overlap of an existing trend. Operates against a pre-fetched pool of recent active trends (typically last 30 days, top 200 by heat).",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Free-text topic description to match against (the noun-verb behavior you're considering proposing). Required if signal_ids is omitted.",
        },
        signal_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Alternative to topic: pass signal ids and the tool computes a centroid embedding from them.",
        },
        k: {
          type: "integer",
          description: "Number of neighbors to return (default 5, max 20).",
        },
        min_similarity: {
          type: "number",
          description:
            "Optional cosine cutoff (0.0-1.0). Defaults to 0.0 (return k regardless).",
        },
      },
    },
  },

  query_trend_metrics: {
    name: "query_trend_metrics",
    description:
      "Look up full metadata for one or more existing trend ids: TREND_TOPIC, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT, VELOCITY_DIRECTION, TREND_HEAT_INDEX, DETECTED_AT, LAST_UPDATE_AT. Use after query_trend_neighbors returns a near-match to decide if the existing trend already adequately covers the pattern.",
    input_schema: {
      type: "object",
      properties: {
        trend_ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more existing trend UUIDs.",
        },
      },
      required: ["trend_ids"],
    },
  },

  validate_dedupe_pair: {
    name: "validate_dedupe_pair",
    description:
      "Compute embedding cosine + token-overlap between a proposed candidate (topic + supporting signal ids) and an existing trend. Returns numeric scores only — does NOT make a merge/separate decision; that's your call as the agent. Useful when query_trend_neighbors surfaces a borderline match and you want a second numeric confirmation.",
    input_schema: {
      type: "object",
      properties: {
        candidate_topic: {
          type: "string",
          description: "The proposed candidate's topic string.",
        },
        candidate_signal_ids: {
          type: "array",
          items: { type: "string" },
          description: "The candidate's supporting signal ids.",
        },
        existing_trend_id: {
          type: "string",
          description: "The existing trend to compare against.",
        },
      },
      required: ["candidate_topic", "existing_trend_id"],
    },
  },

  validate_url_canonical: {
    name: "validate_url_canonical",
    description:
      "Resolve a URL to its canonical form via HEAD request + canonical-link inspection. Returns canonical_url, status, content_type, and a stable hash. Use to dedupe signals that point to the same article via different syndication paths. Times out at 5s per URL.",
    input_schema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "One or more URLs to resolve (max 10 per call).",
        },
      },
      required: ["urls"],
    },
  },
};

const INGEST_SCHEMAS = {
  ingest_search_bluesky: {
    name: "ingest_search_bluesky",
    description:
      "Search Bluesky (ATProto searchPosts) for posts matching a query. Returns up to `limit` posts with author handle, text snippet, like + repost counts, embedded URL if any, created_at. Latency ~6-8s. Use to corroborate emerging signals, gather voice-of-customer quotes, or check whether a hypothesis has cultural traction. All returned posts are also written to STG_EXTERNAL_SIGNALS tagged with the current agent_session_id.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search (use specific multi-word phrases, not single broad words)." },
        limit: { type: "integer", description: "Max posts to return (default 25, max 100)." },
        sort: { type: "string", enum: ["latest", "top"], description: "Result ordering (default 'latest')." },
      },
      required: ["query"],
    },
  },

  ingest_search_gdelt: {
    name: "ingest_search_gdelt",
    description:
      "Search the GDELT global news index (DOC API v2) for articles matching a topic. Returns up to ~150 articles with title, domain, url, published_at, language, tone. Latency ~20-30s due to GDELT rate limits. Use for hard news/article corroboration of emerging consumer behavior signals — much higher recall than ad-hoc web search. All articles also written to STG_EXTERNAL_SIGNALS tagged with the current agent_session_id.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Free-text query — supports GDELT operators (quotes, OR, NEAR/N)." },
        window_days: { type: "integer", description: "Days back from today (default 7, max 30)." },
        mode: { type: "string", enum: ["ArtList", "ArtRecent"], description: "Default ArtList (relevance-ranked); ArtRecent for raw recency." },
      },
      required: ["topic"],
    },
  },

  ingest_search_google_trends: {
    name: "ingest_search_google_trends",
    description:
      "Look up Google Trends interest + related queries for a keyword. Returns trending_searches (recently surging queries) and related_queries (rising/breakout terms). Latency ~30-50s due to Google Trends rate limits — use sparingly, prefer Bluesky/GDELT/Grok first. Useful for confirming whether a candidate behavior has measurable consumer search demand.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Single keyword or short phrase to look up." },
        geo: { type: "string", description: "ISO country code (default 'US')." },
        timeframe: { type: "string", description: "Google Trends timeframe (default 'now 7-d')." },
      },
      required: ["keyword"],
    },
  },

  ingest_grok_live_search: {
    name: "ingest_grok_live_search",
    description:
      "Search X (Twitter) for live posts about a query via Grok's x_search. Returns a 2-3 sentence digest summary plus 3-8 cited real X posts, each with the post URL (x.com/<handle>/status) and a one-sentence context of what that post says. This is the X/social corroboration tool — use it for voice-of-customer and what named accounts are saying on X. (For web/news use ingest_search_gdelt; for search demand use ingest_search_google_trends.) Each cited post is persisted as a grok_live signal.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search X for. Be specific." },
      },
      required: ["query"],
    },
  },
};

const ENRICHMENT_SCHEMAS = {
  query_trend_source_metrics: {
    name: "query_trend_source_metrics",
    description:
      "Look up FCT_TREND_SOURCE_METRICS rows for the trend currently being enriched. Returns one entry per source (gdelt, wikimedia, bluesky, google_trends, amazon, pinterest, tiktok) with headline_metric, headline_metric_name, and the full metrics VARIANT. Reads from a context-provided pool — pre-fetched, not live SQL.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Optional source filter (e.g. 'gdelt'). Omit to return all sources.",
        },
        min_headline_metric: {
          type: "number",
          description: "Optional: only return sources with headline_metric >= this value.",
        },
      },
    },
  },

  propose_enrichment: {
    name: "propose_enrichment",
    description:
      "Emit the final enrichment record for this trend. Call this exactly ONCE near the end of the loop after you've gathered evidence, drafted candidate names with self-critique, validated cited URLs, and finalized the trend profile. The tool's input schema is the canonical DIM_TREND_ENRICHMENT shape — populate every field that applies. Calling this is what causes the workflow to persist anything; if you don't call it, nothing is written.",
    input_schema: {
      type: "object",
      properties: {
        trend_name_b2b: { type: "string", description: "2-5 words, professional/industry register, evocative not generic. AVOID 'ritual', 'daily', 'moment', 'movement', 'era', 'vibe', 'wave', 'trend' unless paired with something specific and unexpected." },
        trend_name_b2c: { type: "string", description: "2-5 words, consumer-facing, distinctive, has texture (sonic / metaphoric / cultural). Same anti-cliché rule applies." },
        summary_short: { type: "string", description: "1-2 sentences, action-oriented (what consumers are doing or buying, not just observing)." },
        summary_long: { type: "string", description: "1 paragraph (≤500 chars), action-oriented, expanded context for deep-dive view." },
        category: { type: "string", enum: ["wellness", "food_beverage", "beauty", "fitness", "fashion", "home_living", "sustainability", "consumer_tech", "personal_care", "social_lifestyle", "entertainment", "travel", "parenting", "other"] },
        subcategory: { type: "string", description: "Lowercase snake_case subcategory specific to this trend." },
        category_confidence: { type: "number", description: "0.0-1.0; your conviction in the category assignment. Set <0.6 if you genuinely couldn't fit it." },
        voice_of_customer: {
          type: "array",
          items: {
            type: "object",
            properties: {
              quote: { type: "string" },
              source_url: { type: "string", description: "Direct URL to the post/comment/review. Required." },
              platform: { type: "string", description: "e.g. 'bluesky', 'reddit', 'tiktok'." },
            },
            required: ["quote", "source_url"],
          },
          description: "3-8 quotes that capture how real people are talking about this. Each MUST have a source_url.",
        },
        vibe_shift: { type: "string", description: "1 sentence on what the cultural mood/movement around this is." },
        social_narrative: {
          type: "array",
          items: {
            type: "object",
            properties: {
              point: { type: "string", description: "A specific narrative point, ≤200 chars." },
              evidence_url: { type: "string", description: "URL backing this point (article, post, search query). Optional but strongly preferred." },
            },
            required: ["point"],
          },
          description: "3-5 narrative points that explain why this is happening now.",
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
            peak_months: { type: "array", items: { type: "string" }, description: "e.g. ['november','december']." },
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
        social_proof: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string", description: "What this proof point asserts." },
              source_url: { type: "string", description: "Click-through URL — required." },
              source_type: { type: "string", enum: ["news", "social", "search_volume", "commerce", "other"] },
              source_name: { type: "string", description: "Display name (e.g. 'BBC News', 'Bluesky')." },
              captured_at: { type: "string", description: "ISO timestamp of when the source was captured." },
            },
            required: ["claim", "source_url", "source_type"],
          },
          description: "≥2 structured proof points the dashboard surfaces with click-throughs. Use cited URLs from your ingest_* tool calls.",
        },
        name_candidates_considered: {
          type: "array",
          items: {
            type: "object",
            properties: {
              audience: { type: "string", enum: ["b2b", "b2c"] },
              name: { type: "string" },
              scores: {
                type: "object",
                properties: {
                  distinctiveness: { type: "number" },
                  whimsy: { type: "number" },
                  specificity: { type: "number" },
                },
              },
            },
            required: ["audience", "name", "scores"],
          },
          description: "All 10 candidates you considered (5 b2b + 5 b2c) with per-axis 0-10 scores. Required for naming-quality audit.",
        },
        reasoning: { type: "string", description: "≤500 chars on why these names + categorization fit." },
      },
      required: ["trend_name_b2b", "trend_name_b2c", "summary_short", "summary_long", "category", "subcategory", "category_confidence", "social_proof", "name_candidates_considered", "reasoning"],
    },
  },
};

const LEAD_ONLY_SCHEMAS = {
  dispatch_subagent: {
    name: "dispatch_subagent",
    description:
      "Send one or more hypotheses to the distillation subagent for deep investigation. Each hypothesis is a candidate trend with its supporting signal ids and a bucket label (OVERLAP | AGENT_ONLY | LOUVAIN_ONLY). Subagents run in parallel (concurrency cap 10) and each returns a verdict (REAL_TREND | CATEGORY_TOO_BROAD | NOISE | DUPLICATE_OF_<id>) plus refined candidates. Use this for any hypothesis where you need extra evidence-gathering or specificity judgment beyond what the lead context can do directly.",
    input_schema: {
      type: "object",
      properties: {
        dispatches: {
          type: "array",
          description: "One or more hypotheses to investigate in parallel (max 20 per call).",
          items: {
            type: "object",
            properties: {
              hypothesis: { type: "string", description: "Noun-verb description of the candidate behavior, ≤200 chars." },
              signal_ids: { type: "array", items: { type: "string" }, description: "Supporting signal ids from your scan + Louvain (3-50 ideal)." },
              bucket: { type: "string", enum: ["OVERLAP", "AGENT_ONLY", "LOUVAIN_ONLY"], description: "Where this hypothesis came from in the reconciliation." },
              budget_tokens: { type: "integer", description: "Token budget for the subagent (default 30000)." },
            },
            required: ["hypothesis", "signal_ids", "bucket"],
          },
        },
      },
      required: ["dispatches"],
    },
  },

  propose_trend_candidate: {
    name: "propose_trend_candidate",
    description:
      "Add a candidate trend to the run's output set. Call this once per accepted candidate AFTER you've validated specificity and dedup. The candidate is queued for write to STG_TREND_CANDIDATES_AGENT at the end of the run; you can call this many times. Be opinionated: only propose if it passes the noun-verb specificity rubric (consumer does X, with product Y, distinct from sibling Z).",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Specific noun-verb behavior, ≤80 chars. Reject if you'd write 'wellness' or 'AI productivity tools'." },
        supporting_signal_ids: { type: "array", items: { type: "string" }, description: "Final supporting signal ids (lead's scan + subagent evidence)." },
        confidence: { type: "number", description: "0.0-1.0, your conviction this represents a real durable consumer pattern." },
        specificity_score: { type: "number", description: "0.0-1.0, how concrete/actionable the topic is (1.0 = noun-verb-product, 0.0 = category)." },
        bucket: { type: "string", enum: ["OVERLAP", "AGENT_ONLY", "LOUVAIN_ONLY"] },
        verdict: { type: "string", enum: ["REAL_TREND", "DUPLICATE_OF"], description: "REAL_TREND for new; DUPLICATE_OF if it merges into an existing trend." },
        dedup_of_trend_id: { type: "string", description: "Required if verdict=DUPLICATE_OF: existing trend uuid." },
        source_breakdown: { type: "object", description: "{source_name: count}." },
        evidence_added: { type: "array", description: "Subagent-fetched signals beyond original cluster, if any." },
        reasoning: { type: "string", description: "≤500 char rationale." },
      },
      required: ["topic", "supporting_signal_ids", "confidence", "specificity_score", "bucket", "verdict", "reasoning"],
    },
  },
};

const META_SCHEMAS = {
  discover_external_tools: {
    name: "discover_external_tools",
    description:
      "Surface the schemas of additional tools you can call. Use this when you need to gather external evidence (web/social/search) and the tool isn't already in your toolbox. Returns the JSON schemas of tools matching the `need` argument; you can then call them by name.",
    input_schema: {
      type: "object",
      properties: {
        need: {
          type: "string",
          enum: ["social", "web", "search", "cultural", "competitive", "all"],
          description:
            "social → Bluesky + Grok/X live search; cultural → Bluesky + Grok/X; web → Google Trends + GDELT; search → GDELT + Google Trends; competitive → GDELT + Google Trends; all → everything. Be specific to keep your context light.",
        },
      },
      required: ["need"],
    },
  },
};

// ────────────────────────────────────────────────────────────────────────
// Tool grouping
// ────────────────────────────────────────────────────────────────────────

export const EAGER_TOOL_NAMES = [
  "query_signals_window",
  "query_louvain_candidates",
  "query_trend_neighbors",
  "query_trend_metrics",
  "validate_dedupe_pair",
  "validate_url_canonical",
  "discover_external_tools",
];

export const LEAD_TOOL_NAMES = [
  ...EAGER_TOOL_NAMES,
  "dispatch_subagent",
  "propose_trend_candidate",
];

export const SUBAGENT_TOOL_NAMES = [
  ...EAGER_TOOL_NAMES.filter((n) => n !== "query_louvain_candidates"),
  "propose_trend_candidate",
];

// Phase 3 enrichment agent: EAGER set minus distillation-specific lookups
// (no Louvain, no signal pool — enrichment focuses on one trend, not the
// whole signal firehose), plus enrichment-specific tools.
export const ENRICHMENT_TOOL_NAMES = [
  "query_trend_neighbors",
  "query_trend_metrics",
  "query_trend_source_metrics",
  "validate_url_canonical",
  "discover_external_tools",
  "propose_enrichment",
];

const DEFERRED_BY_NEED = {
  social: ["ingest_search_bluesky", "ingest_grok_live_search"],
  web: ["ingest_search_google_trends", "ingest_search_gdelt"],
  search: ["ingest_search_gdelt", "ingest_search_google_trends"],
  cultural: ["ingest_search_bluesky", "ingest_grok_live_search"],
  competitive: ["ingest_search_gdelt", "ingest_search_google_trends"],
  all: [
    "ingest_search_bluesky",
    "ingest_search_gdelt",
    "ingest_search_google_trends",
    "ingest_grok_live_search",
  ],
};

const ALL_SCHEMAS = {
  ...QUERY_SCHEMAS,
  ...INGEST_SCHEMAS,
  ...ENRICHMENT_SCHEMAS,
  ...LEAD_ONLY_SCHEMAS,
  ...META_SCHEMAS,
};

export function getToolSchemas(names) {
  return names.map((n) => {
    const s = ALL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return s;
  });
}

// ────────────────────────────────────────────────────────────────────────
// In-process tool implementations (lookups, validates, meta)
// ────────────────────────────────────────────────────────────────────────

function lookupSignals(input, ctx) {
  const pool = ctx.signal_pool || [];
  const { source, domain_contains, text_contains, signal_ids, limit = 25 } = input || {};
  const cap = Math.min(Number(limit) || 25, 100);
  const ids = signal_ids ? new Set(signal_ids) : null;
  const txt = text_contains ? text_contains.toLowerCase() : null;

  const out = [];
  for (const s of pool) {
    if (out.length >= cap) break;
    if (ids && !ids.has(s.signal_id)) continue;
    if (source && s.source_name !== source) continue;
    if (domain_contains && !(s.domain || "").toLowerCase().includes(domain_contains.toLowerCase())) continue;
    if (txt) {
      const hay = `${s.title || ""} ${s.body || ""}`.toLowerCase();
      if (!hay.includes(txt)) continue;
    }
    out.push({
      signal_id: s.signal_id,
      title: s.title,
      source: s.source_name,
      domain: s.domain,
      detected_at: s.detected_at,
      snippet: (s.body || s.title || "").slice(0, 240),
      url: s.url,
    });
  }
  return { signals: out, total_in_pool: pool.length, returned: out.length };
}

function lookupLouvain(input, ctx) {
  const pool = ctx.louvain_pool || [];
  const { min_signal_count = 3, contains_signal_id } = input || {};
  const out = [];
  for (const c of pool) {
    if ((c.signal_count || (c.signal_ids || []).length) < min_signal_count) continue;
    if (contains_signal_id && !(c.signal_ids || []).includes(contains_signal_id)) continue;
    out.push({
      cluster_id: c.cluster_id,
      centroid_topic: c.centroid_topic,
      signal_ids: c.signal_ids,
      signal_count: c.signal_count || (c.signal_ids || []).length,
      distinct_source_count: c.distinct_source_count,
      top_domains: c.top_domains,
    });
  }
  return { clusters: out, total_in_pool: pool.length };
}

function lookupTrendNeighbors(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const { topic, signal_ids, k = 5, min_similarity = 0 } = input || {};
  const cap = Math.min(Number(k) || 5, 20);
  if (!topic && !(signal_ids && signal_ids.length)) {
    return { error: "must provide topic or signal_ids" };
  }
  // Pre-fetch already includes per-trend embedding; for Phase 1 we approximate
  // similarity via token-overlap if no live embedding service is available.
  // The lead's pre-fetch step is responsible for computing the centroid
  // embedding for input.topic if it has access to an embed endpoint;
  // otherwise we fall back to overlap.
  const queryTokens = tokenize(topic || (signal_ids || []).join(" "));
  const scored = pool.map((t) => ({
    trend_id: t.trend_id,
    trend_topic: t.trend_topic,
    total_cluster_size: t.total_cluster_size,
    velocity_direction: t.velocity_direction,
    trend_heat_index: t.trend_heat_index,
    similarity_score: jaccard(queryTokens, tokenize(t.trend_topic)),
  }));
  scored.sort((a, b) => b.similarity_score - a.similarity_score);
  return { neighbors: scored.filter((s) => s.similarity_score >= min_similarity).slice(0, cap) };
}

function lookupTrendMetrics(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const want = new Set(input.trend_ids || []);
  return { metrics: pool.filter((t) => want.has(t.trend_id)) };
}

function validateDedupePair(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const trend = pool.find((t) => t.trend_id === input.existing_trend_id);
  if (!trend) return { error: `trend ${input.existing_trend_id} not in pre-fetched neighbor pool (out of date or out of scope)` };
  const a = tokenize(input.candidate_topic || "");
  const b = tokenize(trend.trend_topic || "");
  return {
    token_overlap_jaccard: jaccard(a, b),
    candidate_token_count: a.size,
    existing_token_count: b.size,
    existing_topic: trend.trend_topic,
    note: "Embedding cosine not computed in Phase 1 (needs vector tool wrapper). Use jaccard + your own judgment.",
  };
}

async function validateUrlCanonical(input) {
  const urls = (input.urls || []).slice(0, 10);
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(u, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
        clearTimeout(timer);
        return {
          input_url: u,
          canonical_url: resp.url,
          status: resp.status,
          content_type: resp.headers.get("content-type") || null,
        };
      } catch (e) {
        return { input_url: u, error: e.message };
      }
    }),
  );
  return { results };
}

function discoverExternalTools(input) {
  const need = (input.need || "all").toLowerCase();
  const wanted = DEFERRED_BY_NEED[need] || DEFERRED_BY_NEED.all;
  return {
    tools: wanted.map((n) => ALL_SCHEMAS[n]),
    note: `Loaded ${wanted.length} tool(s) for need='${need}'. You can now call them by name.`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// HTTP-side tool implementations (ingest_*, dispatch_subagent)
// ────────────────────────────────────────────────────────────────────────

async function postJson(url, body, { timeoutMs = 90_000 } = {}) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return { error: `tool endpoint not configured (got '${url}')` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}: ${text.slice(0, 400)}` };
    }
    return parsed ?? { _raw: text };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function ingestBluesky(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_bluesky, {
    query: input.query,
    limit: input.limit ?? 25,
    sort: input.sort ?? "latest",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}
async function ingestGdelt(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_gdelt, {
    topic: input.topic,
    window_days: input.window_days ?? 7,
    mode: input.mode ?? "ArtList",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 60_000 });
}
async function ingestGoogleTrends(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_google_trends, {
    keyword: input.keyword,
    geo: input.geo ?? "US",
    timeframe: input.timeframe ?? "now 7-d",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 90_000 });
}
async function ingestGrokLive(input, ctx) {
  return postJson(ctx.endpoints?.ingest_grok_live_search, {
    query: input.query,
    mode: input.mode ?? "both",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}

async function dispatchSubagent(input, ctx) {
  const dispatches = (input.dispatches || []).slice(0, 20);
  if (dispatches.length === 0) return { results: [], note: "no dispatches" };
  return fanoutSubagents({
    url: ctx.endpoints?.distillation_subagent,
    dispatches: dispatches.map((d) => ({
      hypothesis: d.hypothesis,
      signal_ids: d.signal_ids,
      bucket: d.bucket,
      budget_tokens: d.budget_tokens ?? 30000,
      agent_session_id: ctx.agent_session_id,
      chain_id: ctx.chain_id,
    })),
    concurrency: 10,
    perCallTimeoutMs: 240_000,
  });
}

function lookupTrendSourceMetrics(input, ctx) {
  const pool = ctx.source_metrics_pool || [];
  const { source, min_headline_metric } = input || {};
  const out = [];
  for (const r of pool) {
    if (source && r.source_name !== source) continue;
    if (typeof min_headline_metric === "number" && Number(r.headline_metric || 0) < min_headline_metric) continue;
    out.push({
      source_name: r.source_name,
      headline_metric: r.headline_metric,
      headline_metric_name: r.headline_metric_name,
      metrics: r.metrics,
    });
  }
  return { source_metrics: out, total_in_pool: pool.length };
}

function proposeEnrichment(input, ctx) {
  // Single-shot accumulator: one enrichment per run. If the agent calls
  // this twice, we keep only the latest (the agent's "final answer").
  ctx.proposed_enrichment = { ...input, emitted_at: new Date().toISOString() };
  return {
    accepted: true,
    note: "Enrichment record captured. The workflow's terminal step will write it to DIM_TREND_ENRICHMENT after the optional name-reviewer pass.",
  };
}

function proposeTrendCandidate(input, ctx) {
  // Pure side-effect on the context's accumulator; the workflow's terminal
  // step bulk-inserts these to STG_TREND_CANDIDATES_AGENT.
  ctx.proposed_candidates = ctx.proposed_candidates || [];
  ctx.proposed_candidates.push({
    ...input,
    candidate_id: cryptoRandomId(),
    chain_id: ctx.chain_id,
    iteration: ctx.iteration,
    agent_session_id: ctx.agent_session_id,
  });
  return {
    accepted: true,
    accepted_count: ctx.proposed_candidates.length,
    candidate_id: ctx.proposed_candidates[ctx.proposed_candidates.length - 1].candidate_id,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Dispatch — single entrypoint called by the agent loop runtime
// ────────────────────────────────────────────────────────────────────────

const DISPATCHERS = {
  query_signals_window: (input, ctx) => lookupSignals(input, ctx),
  query_louvain_candidates: (input, ctx) => lookupLouvain(input, ctx),
  query_trend_neighbors: (input, ctx) => lookupTrendNeighbors(input, ctx),
  query_trend_metrics: (input, ctx) => lookupTrendMetrics(input, ctx),
  validate_dedupe_pair: (input, ctx) => validateDedupePair(input, ctx),
  validate_url_canonical: (input) => validateUrlCanonical(input),
  discover_external_tools: (input) => discoverExternalTools(input),
  ingest_search_bluesky: (input, ctx) => ingestBluesky(input, ctx),
  ingest_search_gdelt: (input, ctx) => ingestGdelt(input, ctx),
  ingest_search_google_trends: (input, ctx) => ingestGoogleTrends(input, ctx),
  ingest_grok_live_search: (input, ctx) => ingestGrokLive(input, ctx),
  dispatch_subagent: (input, ctx) => dispatchSubagent(input, ctx),
  propose_trend_candidate: (input, ctx) => proposeTrendCandidate(input, ctx),
  query_trend_source_metrics: (input, ctx) => lookupTrendSourceMetrics(input, ctx),
  propose_enrichment: (input, ctx) => proposeEnrichment(input, ctx),
};

export async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try {
    return await fn(input || {}, ctx || {});
  } catch (e) {
    return { error: `tool '${name}' threw: ${e.message}` };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function tokenize(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function cryptoRandomId() {
  return "cand-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const _internal = { ALL_SCHEMAS, DEFERRED_BY_NEED };
