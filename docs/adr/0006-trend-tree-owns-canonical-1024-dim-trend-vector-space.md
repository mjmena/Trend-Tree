# Trend-Tree owns the canonical 1024-dim trend vector space; Hunter consumes it

**Status:** accepted (2026-06-08; recorded 2026-09-29)

## Context

Hunter (the Trend Hunter B2C platform) needs a vector per trend for its feed
recommender. The recommender computes distances and clusters over trend vectors
and builds each user's vector as an aggregate of the vectors of trends that
user engaged with. Emil asked who should own that vector space. There were two
options:

1. **Trend-Tree owns the space and Hunter consumes it.** Hunter reads the
   vectors the pipeline already produces.
2. **Hunter owns the space.** Hunter re-embeds our trend text with a model of
   its choosing.

The vectors already exist. Each enrichment writes a 1024-dim
`FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR`, embedded with
`SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', …)` over the
text built by `FN_TREND_EMBED_DOC` (`sql/fn_trend_embed_doc.sql`). The pipeline
already depends on this space: `RELATED_TRENDS`, Trend Connections, attribution
candidate matching and product-sourcing retrieval all run on it. Under Option 2
there would be two trend spaces that drift apart, and nobody would own keeping
them in step.

The vector-exposure work shipped as GitHub archive issue #37 ("expose trend
embedding vector for B2C feed", 2026-06-08). It added
`TREND_VECTOR_ARCTIC_EMBED_L_V2_0` to `DT_TREND_DASHBOARD`
(`sql/dt_trend_dashboard.sql`). `docs/dashboard/data-contract.md` (the
"Embedding ownership" note under *Relationships & embedding*) already tells
consumers the outcome. This ADR records the decision behind that note and the
versioning contract that comes with it. It changes nothing that is live.

## Decision

**Trend-Tree owns the canonical 1024-dim trend vector space, and Hunter
consumes it (Option 1).** Hunter builds its per-user vectors as aggregates of
our trend vectors, so those user vectors are in our space by construction.

Rationale: the vectors already exist under a model we control, so owning the
canonical space costs little. It also avoids the two diverging spaces that
Option 2 would create.

### Versioning contract with Hunter

- **The model is encoded in the exposed column name.** The wire-facing column
  is `TREND_VECTOR_ARCTIC_EMBED_L_V2_0`. The underlying ledger column stays
  `TREND_VECTOR`, and the model suffix is the version marker. Because the name
  carries the model, two spaces existing side by side is a normal schema state
  and not a special case.
- **On a model migration, we add a new column next to the old one.** For
  example, `TREND_VECTOR_<NEWMODEL>` ships while
  `TREND_VECTOR_ARCTIC_EMBED_L_V2_0` keeps being populated.
- **We notify Hunter** before the new column ships.
- **We run a coexistence cutover window.** Both columns are served together so
  Hunter can re-aggregate its user vectors and switch when it chooses. The old
  column is removed only after Hunter confirms it has moved.
- **We never swap silently.** The meaning of an exposed vector column never
  changes to a different model or dimension under the same name.

### What counts as a new space

A new space means a different embedding model or a different dimension.
Changing the recipe that builds the embedded text under the same model does not
create a new space. It keeps the column name and is not a migration under the
contract above. ADR-0003 is an example: it made `descriptor.statement` the
embed seed in `FN_TREND_EMBED_DOC`. The vectors stay in the same
arctic-l-v2.0/1024 space and remain comparable. Individual trend vectors
already change over time as trends are re-enriched (the ledger is
latest-non-null per trend), and consumers should expect that.

### Scope boundary

Only the 1024-dim **trend-concept** space is canonical and exposed. The 768-dim
`snowflake-arctic-embed-m-v1.5` companion space is internal. It powers the
published-content (GSC / `CUE_CONTENT_VECTORS`) match behind `NEAREST_CONTENT`,
and it is never compared with the 1024 space or exposed as a vector column.

## Considered options

- **Option 2: Hunter re-embeds our text in its own space.** Rejected. It
  creates a second trend space that drifts from the one the pipeline uses for
  relatedness and retrieval, and it puts the cost of reconciling the two on the
  consumer.
- **Rename in place on a model change** (keep a single column and swap its
  contents): rejected. Hunter's stored per-user aggregates would silently
  become incomparable with new trend vectors. Coexistence costs one extra
  column for the length of a cutover window.

## Consequences

- A future model migration is a cross-team change. The steps are: add the new
  column, notify Hunter, serve both through the window, then retire the old
  column. It cannot ship as a single-repo deploy.
- `docs/dashboard/data-contract.md` and its Confluence ATLAS mirror must keep
  describing the contract in the same terms as this ADR.
- The vector is about 4 KB per row, so consumers select columns explicitly
  (never `SELECT *`). This rule is already in the data contract.
- The known scale limit is the O(n²) pairwise cosine behind `RELATED_TRENDS`,
  not vector storage. A `VECTOR_SEARCH`/ANN migration is a separate future
  decision and does not affect this contract.
