import test from "node:test";
import assert from "node:assert/strict";
import { extractComments } from "../src/server/automation.js";
import { ruleMatches, type RuleRecord } from "../src/server/rules.js";

const baseRule: RuleRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Guide",
  active: true,
  priority: 100,
  target_scope: "all",
  media_id: null,
  match_mode: "contains",
  keywords: ["гайд"],
  public_reply_enabled: true,
  public_replies: ["Отправили в Direct"],
  dm_text: "Ваш гайд",
  button_text: "Получить",
  button_url: "https://example.com",
  created_at: new Date(),
  updated_at: new Date(),
};

test("keyword matching is case-insensitive and Unicode-normalized", () => {
  assert.equal(ruleMatches(baseRule, {
    commentId: "1", mediaId: "m1", senderId: "u1", text: "Хочу ГАЙД, пожалуйста",
  }), true);
});

test("specific media rules ignore other reels", () => {
  assert.equal(ruleMatches({ ...baseRule, target_scope: "specific", media_id: "m2" }, {
    commentId: "1", mediaId: "m1", senderId: "u1", text: "гайд",
  }), false);
});

test("webhook parser extracts comment events and ignores unrelated changes", () => {
  const result = extractComments({ entry: [{ changes: [
    { field: "messages", value: {} },
    { field: "comments", value: { id: "c1", text: "гайд", from: { id: "u1", username: "anna" }, media: { id: "m1" } } },
  ] }] });
  assert.deepEqual(result, [{ commentId: "c1", mediaId: "m1", senderId: "u1", username: "anna", text: "гайд", isSelf: false }]);
});

test("webhook parser recognizes direct entry payloads and self comments", () => {
  const result = extractComments({ entry: [{ field: "comments", value: {
    id: "c2", text: "гайд", from: { id: "self", username: "owner", self_ig_scoped_id: "self" }, media: { id: "m1" },
  } }] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.isSelf, true);
});
