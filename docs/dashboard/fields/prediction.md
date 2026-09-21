<!-- Title: Prediction (Score / Flag / Eligible) -->
<!-- Parent: ATLAS Dashboard -->

# PREDICTION_SCORE / PREDICTION_FLAG / PREDICTION_ELIGIBLE

**At a glance** — These three fields describe **the call the system is currently making about this trend**: an explicit, falsifiable prediction about what happens next, how sure we are of it, and whether it belongs in the Predictions Queue. Most trends have no active call, and read `NULL` in all three.

**Crucial distinction:** `HEAT_INDEX` and `PREDICTION_SCORE` are both 0–100, easy to conflate.

- [`HEAT_INDEX`](heat-index.md) says **how broadly the world is validating this trend right now**.
- `PREDICTION_SCORE` says **how confident we are in a specific claim about what happens next**.

They are not two views of the same thing. Heat is a measurement of the present; a prediction is a statement about the future that can turn out to be wrong.

> **This changed on 2026-08-24.** These fields used to hold a deterministic emergence score — a daily formula over week-over-week deltas, run on every trend old enough to have two weeks of history. That scorer retired. The names, the 0–100 scale and the flag bands are unchanged; what the numbers *mean* is not. See [engineer-facing detail](../data-contract.md) and the [shadow-run measurements](../prediction-projection-shadow-run.md).

## What a prediction is

A prediction is a **frozen four-part claim**, minted once and never edited:

| Part | Example |
| --- | --- |
| **Subject** — the thing the claim is about | `matcha perfume` |
| **Directional claim** — what changes in the world | prestige beauty retail listings for tea-gourmand fragrance profiles expand beyond indie perfume houses |
| **Horizon** — when it is due to be judged | by Feb 2027 |
| **Observable check** — what we look at to grade it | Sephora US online catalog returns at least five distinct full-size matcha eau de parfum / eau de toilette SKUs |

The observable check is the point. It is specific enough that two people would grade the claim the same way, which is what makes the pillar's track record real rather than rhetorical.

A prediction is re-evaluated on a daily sweep. Each evaluation appends a new verdict — a fresh confidence, a fresh reasoning, and a note on what moved — while the claim itself stays exactly as minted.

## PREDICTION_SCORE

**Scale** — 0–100, one decimal. The **calibrated confidence** of the current verdict: how sure the system is that this claim comes true by its horizon.

**`NULL` means the system is making no call about this trend.** Not "we scored it and it came out low", and not "it is too new to score" — those were the old scorer's reasons. Most trends read `NULL`, and that is the honest answer.

## PREDICTION_FLAG

**Scale** — One of `Emerging` (40–65), `Watchlist` (65–80), `High Potential` (80–100), or `NULL` (score below 40, or no active call). Bands unchanged from the retired scorer, so saved filters keep working.

## PREDICTION_ELIGIBLE

**Scale** — Boolean. `TRUE` when an active prediction currently matches this trend, `NULL` when none does.

**It is never `FALSE`.** The field says "there is a call queued about this trend"; the system has no mechanism for saying "no". The old scorer's six-clause conjunction — heat not peaked, positive acceleration, publisher breadth expanding, cluster forming, age ≥ 14 days, top-30% percentile — is gone entirely. It was a threshold, and a threshold is not a judgement.

## What else is on the card

A queued prediction also brings the narrative that makes it readable:

- **Cited examples** — the source links behind the call, rendered **above** the claim. A card leads with what is already true ("Ulta lists a Burn Notice UV Sensor Sticker 30-pack; Barrière has launched UV patches") and then states what it thinks happens next. Roughly 1 prediction in 10 cites nothing; those cards simply have no examples block.
- **The rendered claim** — the four claim parts as one sentence.
- **Reasoning** — why the system believes it, in its own words.
- **What changed** — what moved since the last time you looked.
- **Angle** — one sentence on why this matters culturally.
- **Audience question** — what this call invites us to ask readers.

Angle and audience question are optional; a card without them shows the claim and the reasoning and reads fine.

## Where predictions do *not* appear

A prediction whose claim matches **no** current trend is a **white-space prediction**. Those are recorded in the verdict ledger and appear on no dashboard surface — v1 keeps them internal until the pillar has been through a full resolution cycle. (Don't confuse this with **white space**, the opportunity-axis condition — live reader demand that McClatchy's own coverage doesn't serve. A white-space prediction says "no *trend* exists yet"; white space says "no *coverage* exists".)

**Where it appears in ATLAS** — Prediction badge on each trend card (when `PREDICTION_FLAG` is non-null). `PREDICTION_ELIGIBLE` gates inclusion in the dedicated Predictions Queue route, which is a separate UI surface from ATLAS.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
