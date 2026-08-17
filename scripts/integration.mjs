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
  const ready = await request("/ready");
  assert.equal(ready.response.status, 200);
  console.log("Integration flow passed: two workers → one leader → self-filter → public reply → private reply.");
} finally {
  await Promise.all(stopWorkers.map((stop) => stop()));
  await app.close();
  await sql.end({ timeout: 5 });
}
