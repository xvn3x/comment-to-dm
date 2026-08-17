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
const stopWorker = startWorker(sql, config, meta, box);
await app.listen({ host: config.HOST, port: config.PORT });
const base = config.PUBLIC_BASE_URL;

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
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
  console.log("Integration flow passed: login → Meta connection → rule → comment → public reply → private reply.");
} finally {
  stopWorker();
  await app.close();
  await sql.end({ timeout: 5 });
}
