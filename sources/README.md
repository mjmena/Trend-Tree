# sources/

Reusable Pipedream **event source components** that emit events into workflows in this repo.

## Sources vs workflows

In Pipedream's model:

- A **workflow** is a sequence of steps that runs when an event arrives. Each workflow has one or more **triggers** that subscribe to an event source.
- A **source** is a thing that emits events — built-in (HTTP endpoints, cron timers, RSS feeds) or custom (a deployed JavaScript component).

The HTTP triggers built into workflows (`hi_xxx` IDs in `workflow.yaml`) are first-class workflow triggers. **Custom-deployed sources** (`dc_xxx` IDs) live separately and can be attached to any workflow's `triggers:` list.

This directory holds the JS code (`source.mjs`) for our custom-deployed sources. One subdirectory per **component**; each component can have N **source instances** (different schedules, different configs, attached to different workflows).

## Publish + instantiate flow

Three steps:

```bash
# 1. Publish the component (registers the .mjs as a Pipedream component sc_xxx)
pd publish sources/noop-timer/source.mjs --json
# → returns { id: "sc_xxxxx", ... }

# 2. Instantiate as a source (creates a runtime instance dc_xxx with configured props)
curl -X POST -H "Authorization: Bearer $PD_KEY" \
  -H 'Content-Type: application/json' \
  https://api.pipedream.com/v1/sources?org_id=o_qOIvyEa \
  -d '{"component_id":"sc_xxxxx","name":"my_source_name","configured_props":{"timer":{"intervalSeconds":14400}}}'
# → returns { data: { id: "dc_xxxxx", endpoint_url: "...", ... } }

# 3. Attach the source to a workflow by adding the dc_xxx ID to its triggers list
# In <workflow-dir>/workflow.yaml:
#   triggers:
#   - id: hi_existing      # existing HTTP trigger
#   - id: dc_xxxxx         # ← new
# Then: git push. After ~60s sync, the workflow has both triggers.
```

To **update an existing source's config** (e.g. change cron from 1h to 4h) without republishing:

```bash
curl -X PUT -H "Authorization: Bearer $PD_KEY" \
  -H 'Content-Type: application/json' \
  https://api.pipedream.com/v1/sources/dc_xxxxx \
  -d '{"configured_props":{"timer":{"intervalSeconds":14400}}}'
```

To **rename a source** (cosmetic — the `dc_xxx` ID is the stable identifier):

```bash
curl -X PUT -H "Authorization: Bearer $PD_KEY" \
  https://api.pipedream.com/v1/sources/dc_xxxxx \
  -d '{"name":"new_name", "name_slug":"new-slug"}'
```

To **deactivate / delete**:

```bash
# pause without deleting:
curl -X PUT https://api.pipedream.com/v1/sources/dc_xxxxx \
  -d '{"active":false}'

# delete entirely:
curl -X DELETE https://api.pipedream.com/v1/sources/dc_xxxxx
```

## Known gotchas

1. **`pd deploy --run --timer --frequency` returns HTTP 500 with "Unexpected error, contact support"** — but the source is created server-side anyway. Verify with `pd list sources`. Ignore the 500. (We use `pd publish` + REST POST instead now — same result, no false error.)
2. **HTTP custom_response IS settable on deployed sources.** Declare `customResponse: true` in the component's `props.http` config. The deployed source endpoint will then honor `this.http.respond({...})` calls. This overrides CLAUDE.md gotcha #6 for the source-attached pattern (the workflow's own HTTP trigger config is still write-once-at-creation).
3. **GitHub sync writes `dc_xxx` triggers into `workflow.yaml` correctly** — same writeback pattern as `authProvisionId`. After adding a source to a workflow's triggers list, the workflow API view will show both triggers attached.

See `~/.claude/projects/-home-marty-dev-Trend-Tree/memory/pipedream_cron_via_repo.md` for the full discovery + reasoning.

## Adding a new source

1. `mkdir sources/<my-source-name>/`
2. Write `source.mjs` (use existing source as a template for the component shape)
3. Write a `README.md` with description + props + deployed-instances table
4. `pd publish sources/<my-source-name>/source.mjs --json` to register
5. `curl POST /v1/sources` to instantiate one or more times with different configs
6. Add each `dc_xxx` to the relevant workflow's `triggers:` list
7. Commit + push the source.mjs + README + workflow.yaml changes
