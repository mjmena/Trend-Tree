<!-- Title: Lifecycle Status -->
<!-- Parent: ATLAS Dashboard -->

# LIFECYCLE_STATUS

**At a glance** — A label for the trend's overall trajectory. Re-checked on a rolling schedule by the lifecycle job. The job runs every hour, and each trend comes up for review about every 6 hours while active and about once a day while dormant (never more than 7 days apart).

**Scale** — One of:

| Status | Meaning |
|---|---|
| `NEW` | Recently promoted. Not enough history yet to assess direction. |
| `GROWING` | Linked signal flow is rising week-over-week across multiple publishers. |
| `STABLE` | Consistent linked signal flow; the trend is established and active. |
| `DECLINING` | Linked signal flow is dropping vs the prior week. |
| `DORMANT` | No linked signals in two weeks. Parked, still watched for a comeback. |
| `RESURGENT` | Fresh linked activity after at least a week of silence — the trend woke back up. |
| `RETIRED` | Dormant ≥ 30 days with no publisher activity; we've stopped surfacing it. Filtered out of ATLAS. |

**What feeds it** — The lifecycle agent's per-trend evaluation, each time the trend comes up for review. Since heat v2 (ADR-0005), status thresholds key **only on raw linked-evidence metrics**: linked signals in the last 7 days vs the prior week, distinct publisher domains active in the last 21 days, and days since the newest linked signal. The agent never reasons backward from the heat number (status feeds heat, so heat must not feed status), and unlinked "candidate" signals are advisory color only.

**Status drives the heat factor** — The status choice applies a fixed factor to the trend's deterministic `heat_base`: GROWING/RESURGENT +10%, STABLE/NEW 0%, DECLINING −10%, DORMANT −15%. See [HEAT_INDEX](heat-index.md).

**Two-cycle retirement** — Prevents single-cycle noise from prematurely retiring a trend. If the agent proposes `RETIRED` but the prior eval didn't, the status stays at its previous value for this cycle and the retirement proposal is logged. If the next eval also proposes `RETIRED`, the flip happens.

**Where it appears in ATLAS** — Card badge / label. Also exposed under the legacy alias `VELOCITY_DIRECTION` for backward compatibility.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
