// Gemini Batch API client: direct fetch(), no SDK, on the Generative Language API.

const API = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiBatchClient({ apiKey, fetch = globalThis.fetch }) {
  async function call(method, path, body) {
    const res = await fetch(`${API}/${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: body && JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Gemini ${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
    return json;
  }

  return {
    async submitBatch({ model, displayName, requests }) {
      const op = await call("POST", `models/${model}:batchGenerateContent`, {
        batch: { displayName, inputConfig: { requests: { requests } } },
      });
      return { name: op.name };
    },

    // A finished batch carries its inlined responses on metadata.output.
    async getBatch(name) {
      const op = await call("GET", name);
      return {
        state: op.metadata?.state,
        entries: op.metadata?.output?.inlinedResponses?.inlinedResponses ?? op.response?.inlinedResponses?.inlinedResponses ?? [],
      };
    },
  };
}
