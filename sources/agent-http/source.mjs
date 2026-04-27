// agent-http — HTTP source with customResponse for long-running workflows.
//
// Pipedream's built-in HTTP triggers have customResponse as a write-once
// toggle at workflow creation time. For workflows scaffolded via the UI
// without that toggle (or where we need to add HTTP triggers programmatically
// to existing workflows), we attach an instance of this deployed-component
// HTTP source instead. props.http.customResponse=true lets the downstream
// workflow call $.respond() to send the actual response.
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
    // Emit so the downstream workflow runs. The workflow's respond step
    // will call $.respond() to actually answer the HTTP request.
    this.$emit(
      { body: event.body, headers: event.headers, query: event.query, method: event.method },
      { summary: `${event.method} ${event.path || "/"}`, ts: Date.now() },
    );
  },
};
