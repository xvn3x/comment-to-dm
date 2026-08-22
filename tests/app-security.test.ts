import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Db } from "../src/server/db.js";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

test("production sessions use a host-only cookie, no-store responses and exact-origin mutations", async () => {
  const password = randomBytes(18).toString("base64url");
  const config = loadConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://comment.example.com",
    DATABASE_URL: `postgres://commentdm:${randomBytes(24).toString("base64url")}@db:5432/commentdm`,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    META_WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString("base64url"),
    META_MODE: "live",
  });
  const unusedSql = (() => {
    throw new Error("This security test must not access the database.");
  }) as unknown as Db;
  const { app } = await buildApp(unusedSql, config);

  try {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.headers["cache-control"], "no-store");
    const setCookie = String(login.headers["set-cookie"]);
    assert.match(setCookie, /^__Host-commentdm_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    assert.doesNotMatch(setCookie, /Domain=/i);
    const sessionCookie = setCookie.split(";", 1)[0];

    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: sessionCookie },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.headers["cache-control"], "no-store");
    assert.equal(session.json().authenticated, true);

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: sessionCookie },
    });
    assert.equal(missingOrigin.statusCode, 403);

    const hostileOrigin = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: sessionCookie, origin: "https://attacker.example" },
    });
    assert.equal(hostileOrigin.statusCode, 403);

    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: sessionCookie, origin: config.PUBLIC_BASE_URL },
    });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers["set-cookie"]), /^__Host-commentdm_session=/);
  } finally {
    await app.close();
  }
});
