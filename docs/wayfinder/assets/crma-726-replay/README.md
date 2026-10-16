# CRMA-726 replay artifacts

Run artifacts from `scripts/replay/` that the closed lane decisions on
[CRMA-726](https://mcclatchy.atlassian.net/browse/CRMA-726) cite. `scripts/replay/out/`
is gitignored, so until [CRMA-746](https://mcclatchy.atlassian.net/browse/CRMA-746)
these files existed in one worktree only. Copied 2026-10-16.

| lane | ticket | included | excluded |
| --- | --- | --- | --- |
| `distillation` | CRMA-732 | all runs | — |
| `promotion` | CRMA-733 | runs after `e864045` (2026-08-20T23:37Z), incl. the 2026-09-21 runs CRMA-1222 made for map CRMA-1214 | 27 pre-fix runs the ticket discards (self-neighbour defect, ET key unset) |
| `lifecycle`, `attribution` | CRMA-734 | runs after `050a8b0` (2026-08-20T23:00Z) | 5 + 4 pre-fix runs the ticket discards (answer leaked to the candidate) |
| `verticals` | CRMA-730 | all runs | — |
| `discovery` | CRMA-731 | all runs, incl. the `gemini-3-flash-preview` incumbent re-run | — |

Probe outputs behind CRMA-757 were already tracked at `scripts/replay/probes/out/`.
Runs for the lanes still open (`enrichment`, `audit`, `daily-digest`, `name-reviewer`)
are not here; their tickets copy what they cite when they resolve.

Artifacts carry no harness commit id; the exclusions above go by the run timestamp in
the filename against the fix commit's time.
