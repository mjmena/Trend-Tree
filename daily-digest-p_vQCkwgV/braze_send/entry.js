// Pipedream Workflow Step: Braze Send
//
// POSTs the rendered HTML digest to Braze /messages/send, targeting a Braze
// segment. Same Braze app id as CRM-Proof-Pipeline/braze-render-p_vQCkbQW.
//
// Auth comes from the Pipedream `braze` app prop; credentials are read from
// this.braze.$auth (api_key, instance_domain, region) — same pattern used by
// CRM-Proof-Pipeline/braze-render-p_vQCkbQW/braze_send/entry.js.

import { axios } from "@pipedream/platform";

const SEGMENT_ID = "e06ba0cc-b339-44ae-bb1b-a3c0a404d820";
const BRAZE_APP_ID = "3f5340d5-1868-4fc0-b783-b36dd6185ab6";
const FROM_EMAIL = "trends@content.mcclatchymedia.com";
const FROM_NAME = "Trend Digest";

export default defineComponent({
  props: {
    braze: {
      type: "app",
      app: "braze",
    },
    subject: {
      type: "string",
      label: "Email subject",
    },
    html_body: {
      type: "string",
      label: "Rendered HTML body",
    },
  },
  async run({ $ }) {
    const payload = {
      broadcast: true,
      segment_id: SEGMENT_ID,
      messages: {
        email: {
          app_id: BRAZE_APP_ID,
          subject: this.subject,
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          body: this.html_body,
        },
      },
    };

    const url = `https://${this.braze.$auth.instance_domain}.braze.${this.braze.$auth.region}/messages/send`;

    const response = await axios($, {
      method: "POST",
      url,
      headers: {
        Authorization: `Bearer ${this.braze.$auth.api_key}`,
        "Content-Type": "application/json",
      },
      data: payload,
    });

    $.export(
      "$summary",
      `Sent "${this.subject}" → segment=${SEGMENT_ID} dispatch_id=${response.dispatch_id ?? "N/A"}`,
    );

    return response;
  },
});
