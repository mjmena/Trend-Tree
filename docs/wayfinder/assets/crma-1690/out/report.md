# CRMA-1690: the attribution comparison in the one-request shape

Snapshot: 300 trends with a non-empty pool (`out/snapshot.jsonl`). Pro ran twice, the candidate once. Pass bar: CRMA-1689.

| Run | Model | Links | Off-pool links | Unparseable | Missing rows |
| --- | --- | --- | --- | --- | --- |
| pro-a | gemini-3.1-pro-preview | 72 | 0 | 0 | 0 |
| pro-b | gemini-3.1-pro-preview | 78 | 0 | 0 | 0 |
| flash | gemini-3.8-flash | 49 | 0 | 0 | 0 |

Overlap: pro-a∩pro-b = 65, flash∩pro-a = 44, flash∩pro-b = 46.

| Measure | Value | Bar | Result |
| --- | --- | --- | --- |
| Pro self-agreement S | 86.8% | — | — |
| flash precision P | 91.8% | ≥ S − 5 pts = 81.8% | pass |
| flash recall R | 60.0% | ≥ S − 25 pts = 61.8% | FAIL |
| flash unparseable | 0.0% | ≤ 2% | pass |
| Pro links, A + B | 150 | ≥ 40 | enough |

**Verdict: FAIL.** link_type agrees with Pro on 77 of 90 shared links (reported, not gated).
