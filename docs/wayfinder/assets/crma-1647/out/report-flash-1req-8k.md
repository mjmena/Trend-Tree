# CRMA-1647 shadow comparison: flash-1req-8k vs Pro

120 trends scored. Noise floor = Pro run A vs Pro run B. Candidate = mean agreement with A and B.

| Gate | Noise floor | Candidate | Bar | Result |
| --- | --- | --- | --- | --- |
| 1. Status, hard strata (n=100) | 99% | 97.5% | ≥ floor − 5 | **pass** |
| 1. Status change rate, controls (n=20) | 0% | 0% | ≤ 2× Pro | **pass** |
| 2. False retirement proposals | — | 0 | 0 | **pass** |
| 2. Missed retirement proposals | 0 Pro disagreements | 2 | ≤ 1 | **FAIL** |
| 3. Interval bucket (n=120) | 100% | 95.8% | ≥ floor − 10 | **pass** |
| 4. Re-enrichment rate | 0% | 0% | 0.5×–2× (ratio n/a) | **pass** |

**All gates: FAIL.** Re-enrichment per-trend agreement (report only): floor 100%, candidate 100%.

## Status agreement by stratum

| Stratum | n | Noise floor | Candidate |
| --- | --- | --- | --- |
| dormant | 25 | 100% | 92% |
| reenrich | 20 | 100% | 100% |
| gd_hold | 15 | 100% | 100% |
| change | 40 | 97.5% | 98.8% |
| control | 20 | 100% | 100% |

## Cost per eval (standard API, thinking tokens included)

| Run | Model | Mean | Median | Median as production records it | Median on a Gemini batch | 600 evals/day on a batch | Input tok | Output tok | Thinking tok | Mean turns | No emission | Budget stops |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pro-a | gemini-3.1-pro-preview | $0.0318 | $0.0313 | $0.0256 | $0.0156 | $9.55 | 11591.5 | 201 | 427.5 | 2 | 0 | 0 |
| pro-b | gemini-3.1-pro-preview | $0.0319 | $0.0311 | $0.0255 | $0.0156 | $9.58 | 11591.5 | 200 | 445.5 | 2 | 0 | 0 |
| flash-1req-8k | gemini-3.8-flash | $0.0067 | $0.0062 | $0.004 | $0.0031 | $2.01 | 4580 | 136 | 564.5 | 1 | 0 | 0 |
