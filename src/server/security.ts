import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(encodedKey: string) {
    this.#key = Buffer.from(encodedKey, "base64");
    if (this.#key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes encoded as base64.");
  }

  seal(plainText: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return ["v1", b64url(iv), b64url(cipher.getAuthTag()), b64url(ciphertext)].join(".");
  }

  open(value: string): string {
    const [version, ivRaw, tagRaw, dataRaw] = value.split(".");
    if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) throw new Error("Invalid encrypted value.");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password, salt, 64);
  return `scrypt.${b64url(salt)}.${b64url(hash)}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [kind, saltRaw, hashRaw] = encoded.split(".");
  if (kind !== "scrypt" || !saltRaw || !hashRaw) return false;
  const expected = Buffer.from(hashRaw, "base64url");
  const actual = scryptSync(password, Buffer.from(saltRaw, "base64url"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSession(secret: string, ttlSeconds = 43_200): string {
  const payload = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySession(value: string | undefined, secret: string): boolean {
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function verifyMetaSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const actual = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyMetaSignedRequest(value: string | undefined, appSecret: string): Record<string, unknown> | null {
  if (!value) return null;
  const [signatureRaw, payloadRaw] = value.split(".");
  if (!signatureRaw || !payloadRaw) return null;
  const expected = createHmac("sha256", appSecret).update(payloadRaw).digest();
  const actual = Buffer.from(signatureRaw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadRaw, "base64url").toString("utf8")) as Record<string, unknown>;
    return String(payload.algorithm ?? "HMAC-SHA256").toUpperCase() === "HMAC-SHA256" ? payload : null;
  } catch {
    return null;
  }
}
