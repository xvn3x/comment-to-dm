import test from "node:test";
import assert from "node:assert/strict";
import { extractComments, extractInboundMessages, extractMessagingActions } from "../src/server/automation.js";
import { inboundRuleMatches, ruleMatches, type RuleRecord } from "../src/server/rules.js";

const baseRule: RuleRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Guide",
  active: true,
  priority: 100,
  trigger_type: "comment",
  target_scope: "all",
  media_id: null,
  match_mode: "contains",
  keywords: ["гайд"],
  public_reply_enabled: true,
  public_replies: ["Отправили в Direct"],
  dm_text: "Ваш гайд",
  button_text: "Получить",
  button_url: "https://example.com",
  follow_gate_enabled: false,
  follow_gate_prompt: null,
  follow_gate_button_text: null,
  follow_gate_retry_text: null,
  follow_up_enabled: false,
  follow_up_delay_minutes: 60,
  follow_up_text: null,
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

test("webhook parser extracts quick replies and postbacks", () => {
  const actions = extractMessagingActions({ entry: [{ messaging: [
    { sender: { id: "user-1" }, timestamp: 100, message: { mid: "mid-1", quick_reply: { payload: "follow_gate:event-1" } } },
    { sender: { id: "user-2" }, timestamp: 200, postback: { mid: "mid-2", payload: "follow_gate:event-2" } },
    { sender: { id: "user-3" }, message: { text: "ordinary message" } },
  ] }] });
  assert.deepEqual(actions, [
    { senderId: "user-1", interactionId: "mid-1", payload: "follow_gate:event-1" },
    { senderId: "user-2", interactionId: "mid-2", payload: "follow_gate:event-2" },
  ]);
});

test("webhook parser separates ordinary Direct messages from Story replies and ignores echoes", () => {
  const messages = extractInboundMessages({ entry: [{ messaging: [
    { sender: { id: "user-1" }, recipient: { id: "business" }, message: { mid: "dm-1", text: "цена" } },
    { sender: { id: "user-2" }, recipient: { id: "business" }, message: {
      mid: "story-1", text: "🔥", reply_to: { story: { id: "story-media-1", url: "https://cdn.example/story" } },
    } },
    { sender: { id: "business" }, message: { mid: "echo-1", text: "answer", is_echo: true } },
    { sender: { id: "user-3" }, message: { mid: "quick-1", text: "Готово", quick_reply: { payload: "gate" } } },
  ] }] });
  assert.deepEqual(messages, [
    { messageId: "dm-1", senderId: "user-1", recipientId: "business", text: "цена", kind: "direct_message", storyId: undefined, isSelf: false },
    { messageId: "story-1", senderId: "user-2", recipientId: "business", text: "🔥", kind: "story_reply", storyId: "story-media-1", isSelf: false },
    { messageId: "echo-1", senderId: "business", recipientId: undefined, text: "answer", kind: "direct_message", storyId: undefined, isSelf: true },
  ]);
});

test("inbound rules match only their own trigger type", () => {
  const directRule: RuleRecord = { ...baseRule, trigger_type: "direct_message", public_reply_enabled: false };
  assert.equal(inboundRuleMatches(directRule, {
    messageId: "dm-1", senderId: "u1", text: "Хочу ГАЙД", kind: "direct_message",
  }), true);
  assert.equal(inboundRuleMatches(directRule, {
    messageId: "story-1", senderId: "u1", text: "гайд", kind: "story_reply", storyId: "s1",
  }), false);
});
