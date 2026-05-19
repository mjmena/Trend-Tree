// Prediction Agent — normalize_event
//
// Cron-fired at daily 06:00 UTC. Manual POSTs can override:
//   { chain_id, dry_run }
//
// dry_run=true scores and returns the summary without inserting to the ledger.

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const body = this.trigger_event?.body || {};

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `pred-chain-${uuid()}`;
    const dry_run = body.dry_run === true || body.dry_run === "true";

    console.log(`pred-sweep: chain=${chain_id} dry_run=${dry_run}`);

    return { chain_id, dry_run };
  },
});
