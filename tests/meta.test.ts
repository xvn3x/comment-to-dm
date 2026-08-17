import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/server/config.js";
import { MetaAmbiguousError, MetaClient, MetaTransportError } from "../src/server/meta.js";

const config = loadConfig({
  NODE_ENV: "test",
  META_MODE: "live",
  META_REQUEST_TIMEOUT_MS: "5000",
});
const context = { igUserId: "17841400000000000", token: "token", graphVersion: "v25.0" };

test("write responses without a Meta object ID are marked ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  try {
    await assert.rejects(new MetaClient(config).publicReply(context, "comment", "reply"), MetaAmbiguousError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pre-connect network failures are safe to retry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    throw error;
  };
  try {
    await assert.rejects(
      new MetaClient(config).privateReply(context, "comment", "message"),
      (error: unknown) => error instanceof MetaTransportError && !error.ambiguous,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connection loss during a write is treated as an uncertain result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    throw error;
  };
  try {
    await assert.rejects(
      new MetaClient(config).publicReply(context, "comment", "message"),
      (error: unknown) => error instanceof MetaTransportError && error.ambiguous,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Instagram usage headers drive adaptive throttling", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message_id: "message-1" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-app-usage": JSON.stringify({ call_volume: 82, cpu_time: 17 }),
    },
  });
  try {
    const result = await new MetaClient(config).privateReply(context, "comment", "message");
    assert.equal(result.usagePercent, 82);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("messaging profile exposes whether the user follows the business", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    username: "guide_reader",
    is_user_follow_business: true,
    is_business_follow_user: false,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await new MetaClient(config).userFollowStatus(context, "scoped-user-id");
    assert.equal(result.username, "guide_reader");
    assert.equal(result.isUserFollowBusiness, true);
    assert.equal(result.isBusinessFollowUser, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
