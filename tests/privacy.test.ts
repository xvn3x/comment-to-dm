import test from "node:test";
import assert from "node:assert/strict";
import { privacyPolicyHtml } from "../src/server/privacy.js";

test("privacy policy describes the application's actual data practices", () => {
  const html = privacyPolicyHtml();
  assert.match(html, /self-hosted/i);
  assert.match(html, /does not receive or have access/i);
  assert.match(html, /not stored in the event journal/i);
  assert.match(html, /automatically removed after 30 days/i);
  assert.match(html, /data-deletion request/i);
  assert.doesNotMatch(html, /TODO|example\.com/i);
});
