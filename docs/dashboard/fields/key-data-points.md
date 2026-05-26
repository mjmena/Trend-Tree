# KEY_DATA_POINTS

**At a glance** — Google Trends interest scalars for the trend, from the most recent daily poll.

**Scale** — Array of up to 2 entries:

| Entry | What it is |
|---|---|
| `interest_peak_pct` | Peak interest in the 30-day window, 0–100 (Google Trends scale) |
| `interest_avg_pct` | Average interest over the same window, 0–100 |

**What feeds it** — The `gtrends-poller` workflow runs daily and pulls Google Trends interest curves for each live trend. The two scalars from the most recent pull surface here. An empty array means the poller hasn't seen the trend yet (or Google Trends returned no data for the query).

**Where it appears in ATLAS** — Data-points section on the trend card.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
