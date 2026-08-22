import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/server/config.js";

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://comment.example.com",
    DATABASE_URL: `postgres://commentdm:${randomBytes(24).toString("base64url")}@db:5432/commentdm`,
    ADMIN_PASSWORD: randomBytes(18).toString("base64url"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    META_WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString("base64url"),
    META_MODE: "live",
    ...overrides,
  };
}

test("production configuration accepts generated secrets and normalizes the public origin", () => {
  const config = loadConfig(productionEnv({ PUBLIC_BASE_URL: "https://comment.example.com/" }));
  assert.equal(config.PUBLIC_BASE_URL, "https://comment.example.com");
});

test("production refuses weak credentials, invalid encryption keys and mock mode", () => {
  assert.throws(() => loadConfig(productionEnv({ ADMIN_PASSWORD: "weak-password" })), /secrets/i);
  assert.throws(() => loadConfig(productionEnv({ SESSION_SECRET: "x".repeat(32) })), /secrets/i);
  assert.throws(() => loadConfig(productionEnv({ ENCRYPTION_KEY: "x".repeat(44) })), /secrets/i);
  assert.throws(() => loadConfig(productionEnv({
    DATABASE_URL: "postgres://commentdm:commentdm@db:5432/commentdm",
  })), /secrets/i);
  assert.throws(() => loadConfig(productionEnv({ META_MODE: "mock" })), /META_MODE/i);
});

test("the public base URL cannot contain credentials, paths, queries or fragments", () => {
  for (const value of [
    "https://user:pass@comment.example.com",
    "https://comment.example.com/admin",
    "https://comment.example.com/?debug=1",
    "https://comment.example.com/#fragment",
  ]) {
    assert.throws(() => loadConfig(productionEnv({ PUBLIC_BASE_URL: value })), /PUBLIC_BASE_URL/i);
  }
  assert.throws(() => loadConfig(productionEnv({ PUBLIC_BASE_URL: "http://comment.example.com" })), /HTTPS/i);
});
