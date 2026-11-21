# CRMA-1651: Gemini Batch API latency for the lifecycle request shape

Measured 2026-10-26. Offline: nothing was deployed, and nothing was written to Snowflake.

**Request shape.** `gemini-3.8-flash`, one inline `batchGenerateContent` job. Each request is the body that `crma-1647/oneshot.mjs --retire-note --max-tokens=8192` sends:

- the system prompt with the tool wording edited out, plus the user message
- `responseSchema` set to `propose_lifecycle_decision`'s input_schema, with `responseMimeType: application/json`
- `thinkingConfig.thinkingLevel` taken from the snapshot (medium)
- `maxOutputTokens: 8192` and `temperature: 1.0`

Each request is keyed by `trend_id` in `metadata.key`. The trends come from the frozen `crma-1647/out/snapshot.jsonl.gz`.

The script is `batch-latency.mjs` (run it with `--size=N`). The raw poll log is `batch-latency-log.jsonl`. The script polled every 60 s. Server-side times come from the batch's `createTime` and `endTime`.

## Results

| | Batch A | Batch B |
| --- | --- | --- |
| Size | 120 (whole snapshot) | 25 (first 25 snapshot rows, all from the `dormant` stratum) |
| Batch name | `batches/4k82kyynnyajgjl6nsn85o7eubj9ixdd7n0z` | `batches/e8ihfeij9d8p4bpa66zh1pwn48t0aljk4b0g` |
| Submitted (UTC) | 2026-10-26 09:30:43 | 2026-10-26 09:33:55 |
| Submit call | 4.2 s, 1.9 MB payload | 3.4 s, 0.37 MB payload |
| First state change | PENDING → RUNNING by the first poll (≤ 64 s) | PENDING → RUNNING by the first poll (≤ 64 s) |
| Server time, create → end | **2 min 48 s** | **5 min 25 s** |
| Client wall time to SUCCEEDED (60 s polls) | 3 min 6 s | 6 min 6 s |
| Returned / keyed | 120 / 120 | 25 / 25 |
| Succeeded / errored | 120 / 0 | 25 / 0 |
| Text that does not parse as JSON | 0 | 1 (`finishReason: MAX_TOKENS`) |
| Missing `status` | 0 | 0 |
| Finish reasons | STOP 120 | STOP 24, MAX_TOKENS 1 |
| Status mix | STABLE 47, DECLINING 33, RETIRED 23, GROWING 15, DORMANT 2 | RETIRED 22, DORMANT 2 |
| Tokens: prompt / candidates / thoughts | 573,790 / 18,636 / 70,412 | 109,352 / 20,026 / 20,193 |
| Cost at batch rates | **$0.382** ($0.0032 per trend) | **$0.116** ($0.0047 per trend) |

Cost is based on $0.375 per million input tokens and $1.875 per million output tokens, with thinking tokens counted as output. The total spent was **$0.50**.

## Reading

- **Both batches finished in minutes.** The bound to plan for is the documented 24 h target, not these numbers. Two samples taken on one morning do not give a distribution.
- **A smaller batch was not faster.** The 25-request batch took about twice as long as the 120-request one. Batch size does not appear to drive completion time at this scale; queueing on Google's side probably does.
- **`batchStats` tells you nothing until the end.** It reported `pendingRequestCount` = all requests through the whole RUNNING phase, then jumped straight to all successful. Partial progress cannot be read from it.
- **One runaway output in batch B.** One trend used up the 8192-token cap. Batch B's candidate tokens were 20k for 25 requests, against 18.6k for 120 in batch A. Its text was cut off and did not parse. The tool-loop path has the same failure mode. A batch consumer still needs to handle a no-JSON row.

## API format notes

- These request fields were all accepted inside an inline batch request, without error:
  - `systemInstruction`
  - `generationConfig.thinkingConfig.thinkingLevel`
  - `responseSchema` with `responseMimeType`
  - `maxOutputTokens`
  - `temperature`
- **Envelope.** The request envelope is `{batch: {displayName, inputConfig: {requests: {requests: [{request, metadata: {key}}]}}}}`. The first POST returns `name: "batches/…"` and `metadata.state: BATCH_STATE_PENDING`. Poll it with `GET v1beta/batches/…`.
- **Where results come back.** Results arrive in `response.inlinedResponses.inlinedResponses[]` on the polled object. Every entry echoed its `metadata.key`.
- **Metadata `@type` says `v1main`.** It reads `google.ai.generativelanguage.v1main.GenerateContentBatch` even though the call went to v1beta. This is cosmetic.
