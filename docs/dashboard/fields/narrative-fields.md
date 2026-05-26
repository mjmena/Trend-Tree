# Narrative fields

`SUMMARY_SHORT`, `SUMMARY_LONG`, `SOCIAL_NARRATIVE`, `CULTURAL_DRIVERS`, `SEASONAL_RELEVANCE`, `GEOGRAPHIC_HOTSPOTS`, `VIBE_SHIFT`

**At a glance** — The free-text descriptions a strategist reads to understand what the trend is about. Written by the enrichment agent in a single pass.

| Field | What it is |
|---|---|
| `SUMMARY_SHORT` | One-sentence summary. |
| `SUMMARY_LONG` | Paragraph-length summary. |
| `SOCIAL_NARRATIVE` | Structured account of what people are saying on social platforms. |
| `CULTURAL_DRIVERS` | Why this trend is happening culturally. |
| `SEASONAL_RELEVANCE` | When (if at all) the trend has seasonal patterns. |
| `GEOGRAPHIC_HOTSPOTS` | Where the trend is concentrated. |
| `VIBE_SHIFT` | One-line shift narrative — what changed. |

**Scale** — Text and arrays, no numeric scoring.

**What feeds it** — Single Claude Sonnet 4.6 agent loop with live cultural grounding (Bluesky / GDELT / Grok live search). The agent reads the supporting signals, fetches additional cultural context, and writes all narrative fields in one pass.

**Refresh** — Unlike names and category, narrative fields are **not** frozen — re-enrichment can update them as a trend evolves.

**Where it appears in ATLAS** — Card description / detail pane.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
