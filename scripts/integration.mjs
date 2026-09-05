import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/server/config.js";
import { createDb } from "../src/server/db.js";
import { buildApp } from "../src/server/app.js";
import { startWorker } from "../src/server/worker.js";
import { requireDisposableDatabase } from "./test-db-guard.mjs";

const testDatabase = requireDisposableDatabase({
  variable: "INTEGRATION_DATABASE_URL",
  command: "npm run test:integration",
});

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3301",
  PUBLIC_BASE_URL: "http://127.0.0.1:3301",
  DATABASE_URL: testDatabase.url,
  ADMIN_PASSWORD: "integration-password",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: randomBytes(24).toString("base64url"),
  META_MODE: "mock",
  QUEUE_INTERVAL_MS: "250",
});

const sql = await createDb(config.DATABASE_URL);
await sql`TRUNCATE jobs, events, rules, oauth_states RESTART IDENTITY CASCADE`;
// Лизу предыдущего прогона сбрасываем здесь же, внутри одноразовой базы,
// чтобы для запуска тестов не приходилось трогать общую dev-базу вручную.
await sql`UPDATE worker_leases SET owner_id = NULL, expires_at = NULL, updated_at = NOW() WHERE singleton = TRUE`;
await sql`
  UPDATE meta_connection SET app_id = NULL, app_secret_enc = NULL, ig_user_id = NULL,
    username = NULL, token_enc = NULL, token_expires_at = NULL, connected_at = NULL,
    outbound_paused = FALSE, health_state = 'healthy', health_reason = NULL,
    rate_limited_until = NULL, next_health_probe_at = NULL
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
  assert.equal(dashboard.body.stats.deliveries_24h, 2);
  assert.equal(dashboard.body.rules.find((rule) => rule.id === created.body.id).analytics.triggered_24h, 1);

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const analytics = await request(
    `/api/analytics?from=${encodeURIComponent(dayStart.toISOString())}&to=${encodeURIComponent(dayEnd.toISOString())}`,
    { headers: auth },
  );
  assert.equal(analytics.response.status, 200);
  assert.equal(analytics.body.unit, "hour");
  assert.equal(analytics.body.buckets.length, 24);
  assert.equal(analytics.body.totals.deliveries, 2);
  assert.equal(analytics.body.totals.byKind.public_reply, 1);
  assert.equal(analytics.body.totals.byKind.private_reply, 1);
  assert.equal(
    analytics.body.buckets.reduce((total, bucket) => total + bucket.deliveries, 0),
    analytics.body.totals.deliveries,
    "The bars must add up to the headline number",
  );
  assert.equal(analytics.body.rules.find((rule) => rule.id === created.body.id).triggered, 1);
  assert.equal(typeof analytics.body.totals.followGatePassed, "number");
  assert.equal(typeof analytics.body.totals.followGatePending, "number");
  assert.equal(typeof analytics.body.totals.followUpSent, "number");
  assert.equal(typeof analytics.body.totals.followUpClicked, "number");
  assert.equal(
    analytics.body.totals.byKind.public_reply
      + analytics.body.totals.byKind.private_reply
      + analytics.body.totals.byKind.direct_message
      + analytics.body.totals.byKind.follow_up,
    analytics.body.totals.deliveries,
    "The breakdown must add up to the headline number",
  );
  const badRange = await request(
    `/api/analytics?from=${encodeURIComponent(dayEnd.toISOString())}&to=${encodeURIComponent(dayStart.toISOString())}`,
    { headers: auth },
  );
  assert.equal(badRange.response.status, 400);
  assert.equal(badRange.body.error, "empty_range");
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
  const [guideTracking] = await sql`
    SELECT tracking_token, delivered_at, first_clicked_at FROM link_tracking
    WHERE event_id = ${dashboard.body.events[0].id}
  `;
  assert.ok(guideTracking.delivered_at, "Tracked material link must be marked delivered");
  assert.equal(guideTracking.first_clicked_at, null);
  const guideClick = await fetch(`${base}/r/${guideTracking.tracking_token}`, { redirect: "manual" });
  assert.equal(guideClick.status, 302);
  assert.equal(guideClick.headers.get("location"), "https://example.com/guide");
  const [clickedGuide] = await sql`SELECT first_clicked_at, click_count FROM link_tracking WHERE tracking_token = ${guideTracking.tracking_token}`;
  assert.ok(clickedGuide.first_clicked_at);
  assert.equal(clickedGuide.click_count, 1);

  const emptyActionRule = await request("/api/rules", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Invalid empty action", active: true, priority: 20, triggerType: "comment",
      targetScope: "all", mediaId: null, matchMode: "contains", keywords: ["ничего"],
      publicReplyEnabled: false, publicReplies: [], directMessageEnabled: false, dmText: "",
      buttonText: null, buttonUrl: null,
    }),
  });
  assert.equal(emptyActionRule.response.status, 400, "A comment rule must have at least one enabled action");

  const publicOnlyRule = await request("/api/rules", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "Comment reply only", active: true, priority: 20, triggerType: "comment",
      targetScope: "all", mediaId: null, matchMode: "contains", keywords: ["ответ"],
      publicReplyEnabled: true, publicReplies: ["Спасибо за комментарий!"],
      directMessageEnabled: false, dmText: "", buttonText: null, buttonUrl: null,
    }),
  });
  assert.equal(publicOnlyRule.response.status, 201);
  assert.equal(publicOnlyRule.body.direct_message_enabled, false);
  const publicOnlyComment = await request("/api/mock/comment", {
    method: "POST", headers: auth,
    body: JSON.stringify({ text: "Нужен только ответ", mediaId: "demo-reel-2", username: "public_only_user" }),
  });
  assert.equal(publicOnlyComment.body.result, "queued");
  let publicOnlyEvent;
  const publicOnlyDeadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [publicOnlyEvent] = await sql`SELECT id, status FROM events WHERE username = 'public_only_user' ORDER BY created_at DESC LIMIT 1`;
  } while (publicOnlyEvent?.status !== "sent" && Date.now() < publicOnlyDeadline);
  assert.equal(publicOnlyEvent.status, "sent");
  const publicOnlyJobs = await sql`SELECT kind FROM jobs WHERE event_id = ${publicOnlyEvent.id}`;
  assert.deepEqual(publicOnlyJobs.map((job) => job.kind), ["public_reply"]);
  const publicOnlyTracking = await sql`SELECT event_id FROM link_tracking WHERE event_id = ${publicOnlyEvent.id}`;
  assert.equal(publicOnlyTracking.length, 0);

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
  // Два worker-процесса запущены выше, но отправлять может только держатель лизы.
  const leaders = await sql`
    SELECT owner_id FROM worker_leases WHERE singleton = TRUE AND owner_id IS NOT NULL AND expires_at > NOW()
  `;
  assert.equal(leaders.length, 1, "Only one worker may hold the leader lease");
  console.log("Integration flow passed: inline postback → durable follower check → final Direct message without duplicates.");
} finally {
  await Promise.all(stopWorkers.map((stop) => stop()));
  await app.close();
  await sql.end({ timeout: 5 });
}
