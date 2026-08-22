import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  SecretBox,
  createSession,
  isAllowedMutationOrigin,
  verifyMetaSignature,
  verifyMetaSignedRequest,
  verifySession,
} from "../src/server/security.js";

test("encrypted secrets round-trip and reject tampering", () => {
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const encrypted = box.seal("IGAA-secret-token");
  assert.equal(box.open(encrypted), "IGAA-secret-token");
  const parts = encrypted.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => box.open(parts.join(".")));
});

test("admin sessions are signed and expire", () => {
  const secret = "s".repeat(40);
  const session = createSession(secret, 60);
  assert.equal(verifySession(session, secret), true);
  assert.equal(verifySession(session, "x".repeat(40)), false);
});

test("Meta webhook and signed callbacks require valid HMAC", () => {
  const secret = "meta-secret";
  const body = Buffer.from('{"entry":[]}');
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyMetaSignature(body, signature, secret), true);

  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "1" })).toString("base64url");
  const signed = `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
  assert.equal(verifyMetaSignedRequest(signed, secret)?.user_id, "1");
});

test("production mutations require an exact same-origin header", () => {
  const allowed = new Set(["https://comment.example.com"]);
  assert.equal(isAllowedMutationOrigin("https://comment.example.com", allowed, true), true);
  assert.equal(isAllowedMutationOrigin("https://evil.example", allowed, true), false);
  assert.equal(isAllowedMutationOrigin(undefined, allowed, true), false);
  assert.equal(isAllowedMutationOrigin(undefined, allowed, false), true);
});
