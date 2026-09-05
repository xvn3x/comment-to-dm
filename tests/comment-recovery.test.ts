import test from "node:test";
import assert from "node:assert/strict";
import { recoverCommentPass, recoveryComment, recoveryRule, type RecoveryCursor, type RecoveryIo } from "../src/server/comment-recovery.js";
import { MetaClient, MetaApiError, type RecoveryPage } from "../src/server/meta.js";
import { loadConfig } from "../src/server/config.js";
import type { RuleRecord } from "../src/server/rules.js";

const now = Date.parse("2026-09-05T12:00:00Z");
const baseline = new Date(now - 3_600_000);
const context = { igUserId: "99", token: "test-token", graphVersion: "v25.0" };
const rule: RuleRecord = {
  id: "00000000-0000-4000-8000-000000000001", name: "Guide", active: true, priority: 100,
  trigger_type: "comment", target_scope: "all", media_id: null, match_mode: "contains", keywords: ["guide"],
  public_reply_enabled: true, public_replies: ["Check Direct"], direct_message_enabled: true, dm_text: "Guide",
  button_text: null, button_url: null, follow_gate_enabled: false, follow_gate_prompt: null,
  follow_gate_button_text: null, follow_gate_retry_text: null, follow_up_enabled: false,
  follow_up_delay_minutes: 60, follow_up_text: null, created_at: baseline, updated_at: baseline,
};
const raw = (id = "11", time = now - 120_000) => ({
  id, text: "guide", timestamp: new Date(time).toISOString(), from: { id: "88", username: "reader" },
});
function harness() {
  const seen = new Set<string>();
  const queued: { id: string; alreadyReplied: boolean }[] = [];
  let saved: RecoveryCursor | object = {};
  const meta = {
    recoveryMedia: async (): Promise<RecoveryPage> => ({ data: [] }),
    recoveryComments: async (): Promise<RecoveryPage> => ({ data: [raw()] }),
    recoveryReplies: async (): Promise<RecoveryPage> => ({ data: [] }),
  };
  const io: RecoveryIo = {
    beforeRead: async () => {}, usage: async () => {}, save: async (cursor) => { saved = structuredClone(cursor); },
    seen: async (id) => seen.has(id),
    enqueue: async (comment, _rule, alreadyReplied) => {
      assert.equal(seen.has(comment.commentId), false);
      seen.add(comment.commentId); queued.push({ id: comment.commentId, alreadyReplied });
    },
  };
  const run = (budget = 8) => recoverCommentPass({ meta, context, rules: [rule], seedMediaIds: ["1"],
    startedAt: baseline, cursor: saved, requestBudget: budget, io, now });
  return { meta, io, seen, queued, run, cursor: () => saved };
}

test("recovery only matches new, mature comments under the original first matching rule", () => {
  const comment = recoveryComment(raw(), "1", "99")!;
  assert.equal(recoveryRule([rule], comment, baseline, now), rule);
  for (const time of [now + 1000, now - 1000, baseline.getTime() - 1, now - 7 * 86_400_000]) {
    assert.equal(recoveryRule([rule], { ...comment, timestamp: new Date(time).toISOString() }, baseline, now), undefined);
  }
  assert.equal(recoveryRule([{ ...rule, updated_at: new Date(now) }, rule], comment, baseline, now), undefined);
  assert.equal(recoveryRule([{ ...rule, target_scope: "specific", media_id: "2" }], comment, baseline, now), undefined);
  assert.equal(recoveryComment({ ...raw(), from: null }, "1", "99"), undefined);
  assert.equal(recoveryComment({ ...raw(), timestamp: "bad" }, "1", "99"), undefined);
  assert.equal(recoveryComment({ ...raw(), from: { id: "99" } }, "1", "99")?.isSelf, true);
  assert.equal(recoveryRule([rule], { ...comment, isSelf: true }, baseline, now), undefined);
});

test("known IDs and persisted cursors make repeated passes idempotent, without storing text", async () => {
  const h = harness();
  assert.equal((await h.run()).queued, 1);
  assert.equal((await h.run()).queued, 0);
  assert.equal(h.queued.length, 1);
  assert.equal(JSON.stringify(h.cursor()).includes("guide"), false);
});

test("budget exhausted mid-page resumes and does not lose the remaining comments", async () => {
  const h = harness();
  h.meta.recoveryComments = async () => ({ data: [raw("11"), raw("12"), raw("13")] });
  for (let i = 0; i < 3; i++) assert.equal((await h.run(2)).requests, 2);
  assert.deepEqual(h.queued.map((c) => c.id), ["11", "12", "13"]);
});

test("existing Instagram replies are passed to the durable skip path", async () => {
  const h = harness();
  h.meta.recoveryReplies = async () => ({ data: [{ id: "44" }] });
  assert.equal((await h.run()).skipped, 1);
  assert.equal(h.queued[0].alreadyReplied, true);
});

test("Meta usage at 80 percent halts further reads", async () => {
  const h = harness();
  h.meta.recoveryComments = async () => ({ data: [raw()], usagePercent: 80 });
  const result = await h.run();
  assert.equal(result.highUsage, true);
  assert.equal(result.requests, 1);
  assert.equal(h.queued.length, 0);
});

test("losing the account/lease before enqueue fails closed and preserves the page", async () => {
  const h = harness();
  let checks = 0;
  h.io.beforeRead = async () => { if (++checks === 3) throw new Error("lease lost"); };
  await assert.rejects(h.run(), /lease lost/);
  assert.equal(h.queued.length, 0);
  assert.deepEqual((h.cursor() as RecoveryCursor).mediaIds, ["1"]);
});

test("deleted media cannot block the remaining media in a pass", async () => {
  const h = harness();
  h.meta.recoveryComments = async () => { throw new MetaApiError("unavailable", 400, 100, 33); };
  await h.run();
  assert.equal(h.queued.length, 0);
  assert.deepEqual((h.cursor() as RecoveryCursor).mediaIds, []);
});

test("media pagination includes old Reels and resumes without following next URLs", async () => {
  const h = harness();
  h.meta.recoveryComments = async () => ({ data: [] });
  let pages = 0;
  h.meta.recoveryMedia = async () => ++pages === 1
    ? { data: [{ id: "2", timestamp: "2020-01-01" }], after: "next-cursor" } : { data: [] };
  await h.run(2);
  assert.deepEqual((h.cursor() as RecoveryCursor).mediaIds, ["2"]);
  await h.run(2);
  assert.equal(pages, 2);
});

test("recovery API uses only official read endpoints and rejects malformed pagination", async () => {
  const original = globalThis.fetch;
  const client = new MetaClient(loadConfig({ NODE_ENV: "test", META_MODE: "live" }));
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.instagram.com");
    assert.equal(url.searchParams.has("access_token"), false);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.equal(init?.method ?? "GET", "GET");
    return new Response(JSON.stringify({ data: [], paging: { next: "https://untrusted.invalid/token" } }), { status: 200 });
  };
  try {
    await assert.rejects(client.recoveryMedia(context), /pagination cursor/);
    await assert.rejects(client.recoveryComments(context, "../evil"), /Invalid recovery edge/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("recovery can be disabled and rejects unsafe request budgets", () => {
  assert.equal(loadConfig({ COMMENT_RECOVERY_ENABLED: "false" }).COMMENT_RECOVERY_ENABLED, false);
  assert.throws(() => loadConfig({ COMMENT_RECOVERY_REQUEST_BUDGET: "1000" }));
});
