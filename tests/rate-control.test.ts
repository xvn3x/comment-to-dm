import test from "node:test";
import assert from "node:assert/strict";
import { MetaApiError } from "../src/server/meta.js";
import { adaptiveIntervalMs, isRateLimitError, retryDecision, withJitter } from "../src/server/rate-control.js";

test("recognizes Meta rate-limit HTTP statuses and Graph error codes", () => {
  assert.equal(isRateLimitError(new MetaApiError("limited", 429)), true);
  assert.equal(isRateLimitError(new MetaApiError("limited", 400, 613)), true);
  assert.equal(isRateLimitError(new MetaApiError("bad request", 400, 100)), false);
});

test("honors Retry-After and does not treat rate limits as permanent failures", () => {
  const decision = retryDecision(new MetaApiError("limited", 429, 4, false, 180), 20, 3);
  assert.deepEqual(decision, { retryable: true, rateLimited: true, delaySeconds: 180 });
});

test("backs off transient failures and rejects permanent API errors", () => {
  assert.deepEqual(retryDecision(new MetaApiError("temporary", 503), 4), {
    retryable: true, rateLimited: false, delaySeconds: 16,
  });
  assert.deepEqual(retryDecision(new MetaApiError("permission", 400, 10), 1), {
    retryable: false, rateLimited: false, delaySeconds: 0,
  });
});

test("slows the worker as Meta usage approaches its dynamic ceiling", () => {
  assert.equal(adaptiveIntervalMs(1000, 40), 1000);
  assert.equal(adaptiveIntervalMs(1000, 60), 2000);
  assert.equal(adaptiveIntervalMs(1000, 80), 5000);
  assert.equal(adaptiveIntervalMs(1000, 90), 10_000);
});

test("jitter stays inside the expected safety band", () => {
  assert.equal(withJitter(100, () => 0), 85);
  assert.equal(withJitter(100, () => 1), 115);
});
