// Pipedream Workflow Step: Braze Send
//
// POSTs the rendered HTML digest to Braze /messages/send. Day-1 config is
// hardcoded below: single test recipient, McClatchy content sender, same
// Braze app id used by CRM-Proof-Pipeline/braze-render-p_vQCkbQW.
//
// Auth comes from the Pipedream `braze` app prop; credentials are read from
// this.braze.$auth (api_key, instance_domain, region) — same pattern used by
// CRM-Proof-Pipeline/braze-render-p_vQCkbQW/braze_send/entry.js.

import { axios } from "@pipedream/platform";

// Hardcoded day-1 values. Move to env vars when we broaden the audience.
const EXTERNAL_USER_ID = "88bc3b24acdbce2ea86d17c8e72a1a893d65b7824e43651db59d0a1b2d90c9a1";
const BRAZE_APP_ID = "3f5340d5-1868-4fc0-b783-b36dd6185ab6";
const FROM_EMAIL = "test@content.mcclatchymedia.com";
const FROM_NAME = "Trend Insights Daily";

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
      external_user_ids: [EXTERNAL_USER_ID],
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
      `Sent "${this.subject}" → dispatch_id=${response.dispatch_id ?? "N/A"}`,
    );

    return response;
  },
});
