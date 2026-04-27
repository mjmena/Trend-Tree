# Pipedream Python step — upsert signals via direct Snowflake connector.
#
# Pipedream's snowflake-execute-sql-query proxy 413's at ~256KB request
# bodies, even with bound :1 parameters (param values are still serialized
# in the HTTP body to the proxy). Going direct via snowflake.connector
# uses the binary connector protocol, so payload size isn't capped by
# Pipedream's HTTP edge.
#
# Calls the MERGE_EXTERNAL_SIGNALS stored proc — the proc owns batching,
# URL column write-through, and target-table validation. We just hand it
# the raw signals_json and let it do the work.
#
# Reads `signals` directly from steps.fetch_source.$return_value rather
# than threading through a prop. Mustache prop-wiring has its own size
# limit (~512KB serialized) and silently truncates large arrays — when
# bluesky pulls 119 signals (~240KB raw), the prop arrived empty.
#
# Wired props (workflow.yaml):
#   snowflake     — connected Snowflake app (key-pair auth)
#   target_table  — STG_EXTERNAL_SIGNALS or STG_EXTERNAL_SIGNALS_TEST

import json


def handler(pd: "pipedream"):
    fetch = pd.steps.get("fetch_source", {}) or {}
    rv = fetch.get("$return_value") or fetch.get("return_value") or {}
    signals = rv.get("signals") or []
    target_table = pd.inputs.get("target_table") or "STG_EXTERNAL_SIGNALS_TEST"

    if not signals:
        print("No signals to upsert; skipping")
        return {"signals": 0, "batches": 0, "skipped": True}

    signals_json = json.dumps(signals)
    print(f"Upserting {len(signals)} signals ({len(signals_json)} bytes) to {target_table}")

    auth = pd.inputs["snowflake"]["$auth"]
    account = auth["account"]
    username = auth["username"]
    private_key = auth["private_key"]

    import snowflake.connector
    from cryptography.hazmat.primitives import serialization

    p_key = serialization.load_pem_private_key(private_key.encode(), password=None)
    pkb = p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    conn = snowflake.connector.connect(
        account=account,
        user=username,
        private_key=pkb,
        database="MCC_RAW",
        schema="MARKETING_DEV",
        role="MARKETING_ENGINEER",
    )

    try:
        cur = conn.cursor()
        cur.execute(
            "CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(%s, '', 500, %s)",
            (signals_json, target_table),
        )
        row = cur.fetchone()
        result = row[0] if row else None
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except Exception:
                pass
        print(f"Upsert result: {result}")
        return result if isinstance(result, dict) else {"raw": str(result)}
    finally:
        conn.close()
