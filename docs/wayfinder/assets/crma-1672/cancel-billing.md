# Does Google bill a cancelled Gemini batch? (CRMA-1672)

Measured 2026-10-26 with `cancel-billing.mjs` (log: `cancel-billing-log.jsonl`): two inline `gemini-3.8-flash` batches of the 120-trend CRMA-1651 one-request shape, cancelled through `batches/<id>:cancel`.

| | Cancel at 0 s | Cancel at 95 s |
|---|---|---|
| Batch | `batches/psbmc7b24ed0b0y97nj65zmpga5dqamfq95l` | `batches/vcy6vjc713cgdr52alp8r49t1eqgkwftgiy1` |
| State before cancel | RUNNING, `pendingRequestCount: 120` | RUNNING, `pendingRequestCount: 120` |
| State after cancel (~10 s) | `BATCH_STATE_SUCCEEDED` | `BATCH_STATE_SUCCEEDED` |
| `batchStats` after cancel | `requestCount: 120, failedRequestCount: 120` | same |
| Each inlined entry | `error {code: 1, message: "The operation was cancelled."}`, `metadata.key` kept, no `response` | same |
| Tokens reported | 0 | 0 |

## Findings

- **A cancelled batch reports no usage.** No entry carries a `response` or `usageMetadata`.
- **The state does not say CANCELLED.** Google reports `BATCH_STATE_SUCCEEDED` with every entry failed. A consumer must read each entry's `error` (code 1 = cancelled) and must know from its own records that it cancelled the batch.
- **Not observed:** a cancel after some entries finished. A running batch showed all entries pending both times, which matches CRMA-1651 (no partial progress).
- **Not checked:** the invoice. Check AI Studio billing for `gemini-3.8-flash` on 2026-10-26 09:51–09:54 UTC; the expected charge is $0.

## Documentation (Gemini Developer API)

- Silent on billing for cancelled or expired batches (`ai.google.dev/gemini-api/docs/batch-mode`, `/pricing`, `/billing`).
- Cancel is best effort: "success is not guaranteed" (`ai.google.dev/api/batch-mode`).
- A request that fails with 400 or 500 is not charged (`ai.google.dev/gemini-api/docs/billing`).
- An expired batch "will not have any results to retrieve" (`batch-mode`).
- Vertex AI only, not binding: "You'll only be charged for the completed work."
