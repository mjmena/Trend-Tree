// Pipedream Workflow Step: Braze Send
//
// POSTs the rendered HTML digest to Braze /messages/send. Single hardcoded
// test recipient on day 1 via the TREND_DIGEST_TEST_EXTERNAL_USER_ID env var.
//
// Auth comes from the Pipedream `braze` app prop; credentials are read from
// this.braze.$auth (api_key, instance_domain, region) — same pattern used by
// CRM-Proof-Pipeline/braze-render-p_vQCkbQW/braze_send/entry.js.

import { axios } from "@pipedream/platform";

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
    external_user_id: {
      type: "string",
      label: "Recipient Braze external_user_id",
    },
    from_email: {
      type: "string",
      label: "From email address",
    },
    from_name: {
      type: "string",
      label: "From display name",
    },
    braze_app_id: {
      type: "string",
      label: "Braze app id (UUID)",
    },
  },
  async run({ $ }) {
    if (!this.external_user_id) {
      throw new Error("TREND_DIGEST_TEST_EXTERNAL_USER_ID env var is not set");
    }
    if (!this.braze_app_id) {
      throw new Error("BRAZE_APP_ID env var is not set");
    }

    const payload = {
      external_user_ids: [this.external_user_id],
      messages: {
        email: {
          app_id: this.braze_app_id,
          subject: this.subject,
          from: `${this.from_name} <${this.from_email}>`,
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
