import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDb } from "../src/server/db.js";
import { loadConfig } from "../src/server/config.js";
import { enqueueComment } from "../src/server/automation.js";
import { startCommentRecovery } from "../src/server/comment-recovery-runner.js";
import { MetaClient } from "../src/server/meta.js";
import { SecretBox } from "../src/server/security.js";
import { requireDisposableDatabase } from "./test-db-guard.mjs";

const database = requireDisposableDatabase({ variable: "INTEGRATION_DATABASE_URL", command: "npm run test:integration" });
const config = loadConfig({ NODE_ENV: "test", META_MODE: "live", DATABASE_URL: database.url,
  ENCRYPTION_KEY: randomBytes(32).toString("base64"), COMMENT_RECOVERY_INTERVAL_SECONDS: "60" });
const sql = await createDb(database.url);
const box = new SecretBox(config.ENCRYPTION_KEY);
const enqueue = (comment, options = {}) => enqueueComment(sql, comment, { publicBaseUrl: config.PUBLIC_BASE_URL, ...options });
const igUserId = "99001";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Recovery integration must never contact a real service"); };
let stops = [];
try {
  await sql`TRUNCATE jobs, events, rules, comment_recovery_state CASCADE`;
  await sql`UPDATE meta_connection SET ig_user_id = ${igUserId}, token_enc = ${box.seal("fixture-token")},
    connected_at = NOW() - INTERVAL '2 hours', outbound_paused = FALSE, health_state = 'healthy',
    rate_limited_until = NULL, next_health_probe_at = NULL WHERE singleton`;
  const ruleId = randomUUID();
  await sql`INSERT INTO rules (id, name, active, target_scope, match_mode, keywords,
    public_replies, dm_text, button_text, button_url, follow_gate_enabled, follow_gate_prompt,
    follow_gate_button_text, follow_gate_retry_text, follow_up_enabled, follow_up_text, updated_at)
    VALUES (${ruleId}, 'Recovery fixture', TRUE, 'all', 'contains', '["guide"]'::jsonb,
      '["Check Direct"]'::jsonb, 'Material', 'Open', 'https://example.com/material', TRUE, 'Follow first',
      'Check', 'Try again', TRUE, 'Reminder', NOW() - INTERVAL '1 hour')`;
  const [rule] = await sql`SELECT updated_at FROM rules WHERE id = ${ruleId}`;
  const timestamp = new Date(Date.now() - 120_000).toISOString();
  const options = { publicBaseUrl: config.PUBLIC_BASE_URL,
    recovery: { igUserId, commentCreatedAt: timestamp, ruleId, ruleUpdatedAt: rule.updated_at.toISOString() } };
  const comment = (id) => ({ commentId: id, senderId: `7${id}`, mediaId: "88001", text: "guide" });
  assert.equal(await enqueue(comment("10001"), options), "queued");
  assert.equal(await enqueue(comment("10001")), "duplicate", "Delayed webhook must not start a second chain");
  const [event] = await sql`SELECT id FROM events WHERE comment_id = '10001'`;
  const jobs = await sql`SELECT kind, payload FROM jobs WHERE event_id = ${event.id}`;
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((j) => j.kind === 'public_reply'));
  assert.match(jobs.find((j) => j.kind === 'private_reply').payload.quickReply.payload, /^follow_gate:/);
  for (const job of jobs) assert.equal(Date.parse(job.payload.expiresAt), Date.parse(timestamp) + 7 * 86_400_000);
  for (const table of ['follow_gate_sessions', 'follow_up_sessions', 'link_tracking']) {
    assert.equal((await sql`SELECT event_id FROM ${sql(table)} WHERE event_id = ${event.id}`).length, 1);
  }
  for (let i = 0; i < 12; i++) {
    const id = String(10100 + i);
    const results = await Promise.all([enqueue(comment(id), options), enqueue(comment(id))]);
    assert.deepEqual(results.sort(), ["duplicate", "queued"], "Concurrent sources enqueue exactly once");
    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM jobs j JOIN events e ON e.id = j.event_id WHERE e.comment_id = ${id}`;
    assert.equal(total, 2);
  }
  const skipped = { ...options, recovery: { ...options.recovery, alreadyReplied: true } };
  assert.equal(await enqueue(comment("10200"), skipped), "duplicate");
  assert.equal(await enqueue(comment("10200")), "duplicate");
  assert.equal((await sql`SELECT j.id FROM jobs j JOIN events e ON e.id = j.event_id WHERE e.comment_id = '10200'`).length, 0);
  assert.equal(await enqueue(comment("10201"), { ...options, recovery: { ...options.recovery, ruleUpdatedAt: new Date().toISOString() } }), "no_match");
  assert.equal(await enqueue(comment("10202"), { ...options, recovery: { ...options.recovery, igUserId: "wrong-account" } }), "no_match");

  // No outbound worker runs here. Even a regression cannot send a real message.
  const meta = new MetaClient({ ...config, META_MODE: "mock" });
  let reads = 0;
  meta.recoveryMedia = async () => { reads++; return { data: [] }; };
  meta.recoveryComments = async () => { reads++; return { data: [{ id: "10300", from: { id: "71300" }, text: "guide", timestamp }] }; };
  meta.recoveryReplies = async () => { reads++; return { data: [] }; };
  const waitFor = async (check) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (await check()) return; await delay(100); }
    throw new Error("Recovery runner timed out");
  };
  stops = [startCommentRecovery(sql, config, meta, box), startCommentRecovery(sql, config, meta, box)];
  await waitFor(async () => (await sql`SELECT last_scan_at FROM comment_recovery_state WHERE last_scan_at IS NOT NULL`).length > 0);
  assert.equal(reads, 2, "Two replicas must share one recovery lease");
  assert.equal((await sql`SELECT id FROM events WHERE comment_id = '10300'`).length, 0, "Initial activation must not backfill history");
  const [initial] = await sql`SELECT started_at FROM comment_recovery_state`;
  await Promise.all(stops.map((stop) => stop())); stops = [];
  const restartedDb = await createDb(database.url);
  try {
    const [restarted] = await restartedDb`SELECT started_at FROM comment_recovery_state`;
    assert.equal(restarted.started_at.getTime(), initial.started_at.getTime(), "Restart preserves the recovery baseline");
  } finally { await restartedDb.end(); }
  await sql`UPDATE comment_recovery_state SET started_at = NOW() - INTERVAL '30 minutes', next_scan_at = NOW(), cursor = '{}'::jsonb`;
  stops = [startCommentRecovery(sql, config, meta, box)];
  await waitFor(async () => (await sql`SELECT id FROM events WHERE comment_id = '10300'`).length > 0);
  assert.equal(await enqueue({ commentId: "10300", senderId: "71300", mediaId: "88001", text: "guide" }), "duplicate");
  await Promise.all(stops.map((stop) => stop())); stops = [];
  // Explicit pause must stop reads as well as sending, while durable state survives.
  await sql`UPDATE meta_connection SET outbound_paused = TRUE WHERE singleton`;
  await sql`UPDATE comment_recovery_state SET next_scan_at = NOW()`;
  const readsBeforePause = reads;
  stops = [startCommentRecovery(sql, config, meta, box)];
  await delay(5500);
  assert.equal(reads, readsBeforePause);
  console.log("Comment recovery integration passed: delayed/racing webhooks, full chain, baseline, restart, pause and replica lease.");
} finally {
  await Promise.all(stops.map((stop) => stop()));
  globalThis.fetch = originalFetch;
  await sql.end({ timeout: 5 });
}
