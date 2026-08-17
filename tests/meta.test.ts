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

test("private replies can ask for profile consent with a quick reply", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: { recipient: { comment_id?: string }; message: { quick_replies?: Array<{ payload: string }> } } | undefined;
  globalThis.fetch = async (_input, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ message_id: "message-quick", recipient_id: "scoped-user" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await new MetaClient(config).privateReply(
      context, "comment", "Нажмите кнопку", undefined,
      { title: "Проверить", payload: "follow_gate:00000000-0000-4000-8000-000000000001" },
    );
    assert.equal(sentBody?.recipient.comment_id, "comment");
    assert.equal(sentBody?.message.quick_replies?.[0]?.payload, "follow_gate:00000000-0000-4000-8000-000000000001");
    assert.equal(result.recipientId, "scoped-user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("follow gate result is sent to the scoped user in Direct", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: {
    recipient: { id?: string };
    message: { attachment?: { payload?: { buttons?: Array<{ url: string }> } } };
  } | undefined;
  globalThis.fetch = async (_input, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ message_id: "message-final" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await new MetaClient(config).directMessage(
      context, "scoped-user", "Ваш материал", { title: "Открыть", url: "https://example.com/guide" },
    );
    assert.equal(sentBody?.recipient.id, "scoped-user");
    assert.equal(sentBody?.message.attachment?.payload?.buttons?.[0]?.url, "https://example.com/guide");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
