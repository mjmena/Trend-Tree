<!-- Title: 🟡 Migrating Fields -->
<!-- Parent: ATLAS Dashboard -->

# 🟡 Migrating from the Insights Agent backend

The fields below currently render on ATLAS cards but are computed by the Insights Agent backend (Marcelo's side). They will be migrated into the McClatchy pipeline. Until migration completes, these sections are placeholders with what we know from the May 22, 2026 sync.

> When a stub fills in to a full deep dive, it'll graduate to its own page under `docs/dashboard/fields/` (or stay here if the depth doesn't warrant a separate page).

<a id="audience-match"></a>

## 🟡 Audience Match

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — A score derived from Chad Burton's audience data; reflects how well the trend matches the publication's target demographics.
**Scale** — TBD (confirm with Marcelo at migration time)
**What feeds it** — TBD
**Where it appears in ATLAS** — TBD

<a id="confidence-score"></a>

## 🟡 Confidence Score

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — Overall trustworthiness rollup for the trend.
**Scale** — TBD (likely 0–100; confirm)
**What feeds it** — TBD
**Where it appears in ATLAS** — TBD

<a id="content-gap"></a>

## 🟡 Content Gap

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — Whether the trend is under-covered in our existing content library (a "gap" we should fill).
**Scale** — TBD
**What feeds it** — TBD
**Where it appears in ATLAS** — TBD

<a id="revenue-potential"></a>

## 🟡 Revenue Potential

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline. Marcelo is working with Chad on Google Search Console data; pending warehouse capacity.

**At a glance** — Estimated revenue if we publish on this trend.
**Scale** — TBD
**What feeds it** — Google Search Console data + content performance history (per the May 22 sync)
**Where it appears in ATLAS** — TBD

<a id="ai-match"></a>

## 🟡 AI Match %

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — Vectorization-based match between the trend and items in the CSA content library. Powers the Collections graph (out of scope for this doc).
**Scale** — Percent (0–100)
**What feeds it** — LLM-driven vector comparison between the trend's enrichment payload and CSA content metadata
**Where it appears in ATLAS** — TBD (likely Collections only — confirm whether it surfaces on the main card)

<a id="overall-score"></a>

## 🟡 Overall Score (Green / Yellow / Red)

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — A weighted rollup of Trend Strength + Audience Match + Content Gap + Revenue Potential into a single decision-friendly score with a color band.
**Scale** — 0–100 with thresholds: ≥ 75 green / 50–74 yellow / < 50 red.
**What feeds it** — The four inputs above.
**Where it appears in ATLAS** — Decision Page (out of scope for this doc). Confirm whether the color band also surfaces on the main card.

---

← Back to [hub](index.md)
