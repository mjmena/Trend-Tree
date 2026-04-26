# noop-timer

Generic "wake up this workflow on a schedule" event source.

## What it does

Emits an empty event on each timer tick. Workflows that want to fire on a schedule attach an instance of this source to their `triggers:` list — the workflow runs on every tick. The emitted event is intentionally minimal (just `summary` + `ts`) since the consuming workflows don't need a payload (their own steps fetch whatever they need).

## Component

| Field | Value |
|---|---|
| Pipedream component ID | `sc_jdiAW2jR` |
| Component key | `noop_timer` |
| Version | 0.0.1 |
| Source file | `source.mjs` |

## Deployed instances

| Instance ID | Name | Interval | Attached to workflow |
|---|---|---|---|
| `dc_Dvug1PJ` | discovery_cron_4h | 14400s (4h) | `discovery-p_5VCPP3N` (Discovery) |

## Adding a new instance

```bash
# Create a 6-hour instance for some other workflow
curl -X POST -H "Authorization: Bearer $PD_KEY" \
  -H 'Content-Type: application/json' \
  https://api.pipedream.com/v1/sources?org_id=o_qOIvyEa \
  -d '{"component_id":"sc_jdiAW2jR","name":"my_cron_6h","configured_props":{"timer":{"intervalSeconds":21600}}}'

# Note the dc_xxx returned, then add it to the target workflow.yaml:
#   triggers:
#   - id: hi_existing
#   - id: dc_xxx        # ← new
```

For wall-clock cron expressions (e.g. "every day at 6am UTC") use:

```json
{"configured_props":{"timer":{"cron":"0 6 * * *"}}}
```

instead of `intervalSeconds`.

## Updating an instance's interval

```bash
curl -X PUT https://api.pipedream.com/v1/sources/dc_Dvug1PJ \
  -d '{"configured_props":{"timer":{"intervalSeconds":21600}}}'
```

Takes effect immediately; the next tick fires on the new schedule. `emit_on_deploy: true` (default) means an update may also trigger an immediate fire — check the workflow's events feed if you don't want that.

## Notes

- `pd publish source.mjs --json` returned 500 the first time we ran it on `pd deploy`, but the component DID register on Pipedream. We use `pd publish` (not `pd deploy`) now because it cleanly returns the `sc_xxx` ID.
- See `../README.md` for the full source-creation workflow.
