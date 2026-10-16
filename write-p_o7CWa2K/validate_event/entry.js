// Write — validate_event
//
// The SQL steps below paste body.trend_id inside quotes, and the HTTP
// trigger needs no auth. Throwing here stops the run before any SQL (CRMA-1445).

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const trend_id = this.trigger_event?.body?.trend_id;
    if (typeof trend_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(trend_id)) {
      throw new Error(`invalid trend_id: ${JSON.stringify(trend_id)?.slice(0, 80)}`);
    }
    return { trend_id };
  },
});
