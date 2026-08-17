import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/server/config.js";
import { createDb } from "../src/server/db.js";
import { buildApp } from "../src/server/app.js";
import { startWorker } from "../src/server/worker.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3301",
  PUBLIC_BASE_URL: "http://127.0.0.1:3301",
  DATABASE_URL: process.env.INTEGRATION_DATABASE_URL || "postgres://commentdm@127.0.0.1:55432/commentdm",
  ADMIN_PASSWORD: "integration-password",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: randomBytes(24).toString("base64url"),
  META_MODE: "mock",
  QUEUE_INTERVAL_MS: "250",
});

const sql = await createDb(config.DATABASE_URL);
await sql`TRUNCATE jobs, events, rules, oauth_states RESTART IDENTITY CASCADE`;
await sql`
  UPDATE meta_connection SET app_id = NULL, app_secret_enc = NULL, ig_user_id = NULL,
    username = NULL, token_enc = NULL, token_expires_at = NULL, connected_at = NULL
  WHERE singleton = TRUE
`;

const { app, meta, box } = await buildApp(sql, config);
const stopWorkers = [
  startWorker(sql, config, meta, box),
  startWorker(sql, config, meta, box),
];
await app.listen({ host: config.HOST, port: config.PORT });
const base = config.PUBLIC_BASE_URL;

async function request(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

try {
  const privacy = await fetch(`${base}/privacy`);
  assert.equal(privacy.status, 200);
  assert.match(privacy.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.match(privacy.headers.get("content-security-policy") || "", /object-src 'none'/);

  const login = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: config.ADMIN_PASSWORD }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const auth = { Cookie: cookie };

  const metaConfig = await request("/api/meta/config", {
    method: "POST", headers: auth,
    body: JSON.stringify({ appId: "1234567890", appSecret: "integration-app-secret", graphVersion: "v25.0" }),
  });
  assert.equal(metaConfig.response.status, 200);

  const oauth = await request("/api/meta/oauth-url", { headers: auth });
  assert.equal(oauth.response.status, 200);
  const callback = await fetch(oauth.body.url, { redirect: "manual" });
  assert.equal(callback.status, 302);

  const health = await request("/api/meta/health-check", { method: "POST", headers: auth });
  assert.equal(health.response.status, 200);
  assert.ok(health.body.subscribedFields.includes("comments"));

  const created = await request("/api/rules", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Integration guide",
      active: true,
      priority: 100,
      targetScope: "all",
      mediaId: null,
      matchMode: "contains",
      keywords: ["гайд"],
      publicReplyEnabled: true,
      publicReplies: ["Отправили информацию в Direct"],
      dmText: "Ваш гайд готов",
      buttonText: "Получить гайд",
      buttonUrl: "https://example.com/guide",
    }),
  });
  assert.equal(created.response.status, 201);

  const selfWebhook = await request("/webhooks/instagram", {
    method: "POST",
    body: JSON.stringify({ entry: [{ changes: [{ field: "comments", value: {
      id: "self-comment", text: "гайд", media: { id: "demo-reel-1" },
      from: { id: "17841400000000000", username: "demo_account" },
    } }] }] }),
  });
  assert.equal(selfWebhook.response.status, 200);
  const selfEvents = await sql`SELECT id FROM events WHERE comment_id = 'self-comment'`;
  assert.equal(selfEvents.length, 0, "Comments written by the connected account must be ignored");

  const mock = await request("/api/mock/comment", {
    method: "POST", headers: auth,
    body: JSON.stringify({ text: "Хочу ГАЙД", mediaId: "demo-reel-1", username: "integration_user" }),
  });
  assert.equal(mock.body.result, "queued");

  let dashboard;
  const deadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    dashboard = await request("/api/dashboard", { headers: auth });
  } while (dashboard.body.events[0]?.status !== "sent" && Date.now() < deadline);
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.connection.username, "demo_account");
  assert.equal(dashboard.body.events[0].status, "sent");
  assert.equal(dashboard.body.stats.sent_24h, 1);
  const follow = await request("/api/meta/follow-status", {
    method: "POST", headers: auth,
    body: JSON.stringify({ eventId: dashboard.body.events[0].id }),
  });
  assert.equal(follow.response.status, 200);
  assert.equal(follow.body.available, true);
  assert.equal(follow.body.isUserFollowBusiness, true);
  const delivered = await sql`SELECT kind, attempts FROM jobs ORDER BY kind`;
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((job) => job.attempts === 1), "Leader lease must prevent duplicate dispatch attempts");

  const directRule = await request("/api/rules", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Direct price", active: true, priority: 10, triggerType: "direct_message",
      targetScope: "all", mediaId: null, matchMode: "contains", keywords: ["цена"],
      publicReplyEnabled: false, publicReplies: [], dmText: "Вот информация о цене",
      buttonText: "Открыть", buttonUrl: "https://example.com/price",
      followUpEnabled: true, followUpDelayMinutes: 1,
      followUpText: "Напоминаем: информация о цене доступна по кнопке",
    }),
  });
  assert.equal(directRule.response.status, 201);
  const directWebhook = await request("/webhooks/instagram", {
    method: "POST",
    body: JSON.stringify({ entry: [{ messaging: [{
      sender: { id: "direct-user" }, recipient: { id: "17841400000000000" }, timestamp: Date.now(),
      message: { mid: "integration-direct-1", text: "Какая цена?" },
    }] }] }),
  });
  assert.equal(directWebhook.response.status, 200);
  let followUpSession;
  const directDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [followUpSession] = await sql`
      SELECT s.*, e.status AS event_status FROM follow_up_sessions s
      JOIN events e ON e.id = s.event_id WHERE e.comment_id = 'integration-direct-1'
    `;
  } while (followUpSession?.status !== "scheduled" && Date.now() < directDeadline);
  assert.equal(followUpSession.status, "scheduled");
  assert.equal(followUpSession.event_status, "sent", "Delayed follow-up must not keep the main event pending");
  const tracked = await fetch(`${base}/r/${followUpSession.tracking_token}`, { redirect: "manual" });
  assert.equal(tracked.status, 302);
  assert.equal(tracked.headers.get("location"), "https://example.com/price");
  const [cancelledFollowUp] = await sql`SELECT status, clicked_at FROM follow_up_sessions WHERE event_id = ${followUpSession.event_id}`;
  assert.equal(cancelledFollowUp.status, "cancelled");
  assert.ok(cancelledFollowUp.clicked_at);
  const [skippedFollowUp] = await sql`SELECT status FROM jobs WHERE event_id = ${followUpSession.event_id} AND kind = 'follow_up'`;
  assert.equal(skippedFollowUp.status, "skipped");

  const storyRule = await request("/api/rules", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Story reaction", active: true, priority: 10, triggerType: "story_reply",
      targetScope: "all", mediaId: null, matchMode: "any", keywords: [],
      publicReplyEnabled: false, publicReplies: [], dmText: "Спасибо за реакцию!",
      buttonText: null, buttonUrl: null,
    }),
  });
  assert.equal(storyRule.response.status, 201);
  const storyWebhook = await request("/webhooks/instagram", {
    method: "POST",
    body: JSON.stringify({ entry: [{ messaging: [{
      sender: { id: "story-user" }, recipient: { id: "17841400000000000" }, timestamp: Date.now(),
      message: { mid: "integration-story-1", text: "🔥", reply_to: { story: { id: "story-42", url: "https://cdn.example/story" } } },
    }] }] }),
  });
  assert.equal(storyWebhook.response.status, 200);
  let storyEvent;
  const storyDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [storyEvent] = await sql`SELECT status, trigger_type, media_id FROM events WHERE comment_id = 'integration-story-1'`;
  } while (storyEvent?.status !== "sent" && Date.now() < storyDeadline);
  assert.deepEqual(storyEvent, { status: "sent", trigger_type: "story_reply", media_id: "story-42" });

  const gateRule = await request("/api/rules", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Follower gate", active: true, priority: 50, targetScope: "all", mediaId: null,
      matchMode: "contains", keywords: ["проверка"], publicReplyEnabled: false, publicReplies: [],
      dmText: "Ваш закрытый материал", buttonText: "Открыть", buttonUrl: "https://example.com/private",
      followGateEnabled: true, followGatePrompt: "Сначала проверим подписку",
      followGateButtonText: "Проверить", followGateRetryText: "Подпишитесь и попробуйте ещё раз",
    }),
  });
  assert.equal(gateRule.response.status, 201);
  const gateComment = await request("/api/mock/comment", {
    method: "POST", headers: auth,
    body: JSON.stringify({ text: "проверка", mediaId: "demo-reel-1", username: "gate_user" }),
  });
  assert.equal(gateComment.body.result, "queued");
  let gateSession;
  const gateDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const rows = await sql`
      SELECT s.*, e.id AS event_id FROM follow_gate_sessions s JOIN events e ON e.id = s.event_id
      WHERE e.username = 'gate_user' ORDER BY e.created_at DESC LIMIT 1
    `;
    gateSession = rows[0];
  } while (gateSession?.status !== "awaiting_interaction" && Date.now() < gateDeadline);
  assert.equal(gateSession.status, "awaiting_interaction");
  assert.equal(gateSession.scoped_user_id, "mock-user-demo_follower");

  const rejectedSender = await request("/webhooks/instagram", {
    method: "POST",
    body: JSON.stringify({ entry: [{ messaging: [{
      sender: { id: "another-user" }, timestamp: Date.now(),
      postback: { mid: "wrong-user-postback", payload: `follow_gate:${gateSession.event_id}` },
    }] }] }),
  });
  assert.equal(rejectedSender.response.status, 200);
  const rejectedJobs = await sql`SELECT id FROM jobs WHERE event_id = ${gateSession.event_id} AND kind = 'follow_check'`;
  assert.equal(rejectedJobs.length, 0, "Another user must not be able to trigger a follower gate");

  const postbackBodies = ["integration-postback-1", "integration-postback-2"].map((mid) => JSON.stringify({
    entry: [{ messaging: [{
      sender: { id: "mock-user-demo_follower" }, timestamp: Date.now(),
      postback: { mid, title: "Проверить", payload: `follow_gate:${gateSession.event_id}` },
    }] }],
  }));
  const [postback, duplicatePostback] = await Promise.all([
    request("/webhooks/instagram", { method: "POST", body: postbackBodies[0] }),
    request("/webhooks/instagram", { method: "POST", body: postbackBodies[1] }),
  ]);
  assert.equal(postback.response.status, 200);
  assert.equal(duplicatePostback.response.status, 200);
  let finalSession;
  const finalDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [finalSession] = await sql`SELECT * FROM follow_gate_sessions WHERE event_id = ${gateSession.event_id}`;
  } while (finalSession?.status !== "delivered" && Date.now() < finalDeadline);
  assert.equal(finalSession.status, "delivered");
  const directJobs = await sql`SELECT status, attempts FROM jobs WHERE event_id = ${gateSession.event_id} AND kind = 'direct_message'`;
  assert.equal(directJobs.length, 1);
  assert.equal(directJobs[0].status, "sent");
  const followJobs = await sql`SELECT status, attempts FROM jobs WHERE event_id = ${gateSession.event_id} AND kind = 'follow_check'`;
  assert.equal(followJobs.length, 1, "Concurrent postbacks must collapse into one follower check");
  assert.equal(followJobs[0].status, "sent");

  const notFollowingComment = await request("/api/mock/comment", {
    method: "POST", headers: auth,
    body: JSON.stringify({ text: "проверка", mediaId: "demo-reel-1", username: "not_follower" }),
  });
  assert.equal(notFollowingComment.body.result, "queued");
  let notFollowingSession;
  const retryDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const rows = await sql`
      SELECT s.*, e.id AS event_id FROM follow_gate_sessions s JOIN events e ON e.id = s.event_id
      WHERE e.username = 'not_follower' ORDER BY e.created_at DESC LIMIT 1
    `;
    notFollowingSession = rows[0];
  } while (notFollowingSession?.status !== "awaiting_interaction" && Date.now() < retryDeadline);
  assert.equal(notFollowingSession.status, "awaiting_interaction");
  await sql`UPDATE follow_gate_sessions SET scoped_user_id = 'mock-user-not_follower' WHERE event_id = ${notFollowingSession.event_id}`;
  const retryPostback = await request("/webhooks/instagram", {
    method: "POST",
    body: JSON.stringify({ entry: [{ messaging: [{
      sender: { id: "mock-user-not_follower" }, timestamp: Date.now(),
      postback: { mid: "not-following-postback", title: "Проверить", payload: `follow_gate:${notFollowingSession.event_id}` },
    }] }] }),
  });
  assert.equal(retryPostback.response.status, 200);
  let retryJob;
  const retryDeliveryDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [retryJob] = await sql`
      SELECT status, payload FROM jobs
      WHERE event_id = ${notFollowingSession.event_id} AND kind = 'direct_message'
      ORDER BY created_at DESC LIMIT 1
    `;
  } while (retryJob?.status !== "sent" && Date.now() < retryDeliveryDeadline);
  assert.equal(retryJob.status, "sent");
  assert.equal(retryJob.payload.sessionStatus, "awaiting_follow");
  assert.equal(retryJob.payload.quickReply.title, "Проверить");
  const ready = await request("/ready");
  assert.equal(ready.response.status, 200);
  console.log("Integration flow passed: inline postback → durable follower check → final Direct message without duplicates.");
} finally {
  await Promise.all(stopWorkers.map((stop) => stop()));
  await app.close();
  await sql.end({ timeout: 5 });
}
