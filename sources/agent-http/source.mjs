// agent-http — HTTP source with customResponse for long-running workflows.
//
// Pipedream's built-in HTTP triggers have customResponse as a write-once
// toggle at workflow creation time. For workflows scaffolded via the UI
// without that toggle (or where we need to add HTTP triggers programmatically
// to existing workflows), we attach an instance of this deployed-component
// HTTP source instead. props.http.customResponse=true means THIS source
// owns the HTTP response (a $.respond() call in a downstream workflow step
// does not reach the caller) — so run() below must call
// this.http.respond(...) itself, or the gateway times out and returns its
// own 400 "Error in workflow" (CRMA-451).
//
// Multiple workflows can each get their own instance via POST /v1/sources.
// Endpoint URL comes back in the create response.
//
// Component published to Pipedream as sc_TBD (key: agent_http, v0.0.1).

export default {
  name: "Agent_http",
  version: "0.0.1",
  key: "agent_http",
  description: "HTTP trigger with customResponse=true for agent workflows that need to control the response body (e.g., return proposed candidates from a subagent).",
  type: "source",
  props: {
    http: {
      type: "$.interface.http",
      customResponse: true,
    },
  },
  methods: {},
  async run(event) {
    // Emit so the downstream workflow runs.
    this.$emit(
      { body: event.body, headers: event.headers, query: event.query, method: event.method },
      { summary: `${event.method} ${event.path || "/"}`, ts: Date.now() },
    );

    // Acknowledge the request immediately. customResponse=true makes this
    // source responsible for the HTTP response — without this call the
    // gateway waits, times out, and sends its own 400 "Error in workflow"
    // to the caller even though the downstream workflow runs fine. The
    // workflow's actual output lands in Snowflake, not in this response.
    this.http.respond({
      status: 200,
      body: { ok: true, received_at: Date.now() },
    });
  },
};
