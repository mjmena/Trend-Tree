# LIFECYCLE_STATUS

**At a glance** — A label for the trend's overall trajectory. Updated every hour by the lifecycle agent.

**Scale** — One of:

| Status | Meaning |
|---|---|
| `NEW` | Recently promoted. Not enough history yet to assess direction. |
| `STABLE` | Consistent signal flow; the trend is established and active. |
| `STAGNANT` | Signal flow has plateaued. Not declining, but not growing either. |
| `DECLINING` | Signal flow is dropping vs prior windows. |
| `RETIRED` | The trend has gone quiet long enough that we've stopped surfacing it. Filtered out of ATLAS. |

**What feeds it** — The lifecycle agent's per-trend evaluation each hour: recent signal flow vs prior windows, the trend's age, and (for retirement) two-cycle confirmation — both the current eval and the prior eval must propose RETIRE before the status flips.

**Two-cycle retirement** — Prevents single-cycle noise from prematurely retiring a trend. If the agent proposes `RETIRED` but the prior eval didn't, the status stays at its previous value for this cycle and the retirement proposal is logged. If the next eval also proposes `RETIRED`, the flip happens.

**Where it appears in ATLAS** — Card badge / label. Also exposed under the legacy alias `VELOCITY_DIRECTION` for backward compatibility.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
