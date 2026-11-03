# CRMA-1687: the attribution agent's cost per eval and per day

Sample: 50 eligible trends frozen once (`out/snapshot.jsonl`). Per day = mean × 720 evals. Thinking tokens billed at the output rate.

| Run | Model | Shape | n (called) | Mean / eval | Median / eval | Mean as production records it | Per day, standard | Per day, Gemini batch | Per day, batch at 2027 rates | Mean input tok | Mean output tok | Mean thinking tok | Mean turns | No answer | Budget stops | MAX_TOKENS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pro-loop | gemini-3.1-pro-preview | tool loop | 50 (50) | $0.0250 | $0.0255 | $0.0177 | $18.02 | — | — | 8086 | 123 | 615 | 1.98 | 1 | 0 | 1 |
| pro-1req | gemini-3.1-pro-preview | one request | 50 (50) | $0.0136 | $0.0131 | $0.0071 | $9.82 | $4.91 | — | 3401 | 26 | 544 | 1.00 | 0 | 0 | 0 |
| flash-1req | gemini-3.8-flash | one request | 50 (50) | $0.0060 | $0.0057 | $0.0026 | $4.35 | $2.18 | $4.35 | 3401 | 18 | 913 | 1.00 | 0 | 0 | 0 |

Mean attributed per called trend (a count, not a precision measure; precision is CRMA-1690):

- pro-loop: 0.04 (2 links)
- pro-1req: 0.28 (14 links)
- flash-1req: 0.16 (8 links)
