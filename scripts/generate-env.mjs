import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = new URL("../.env", import.meta.url);
if (existsSync(target)) {
  console.error(".env already exists. Remove it manually only if you intentionally want new secrets.");
  process.exit(1);
}

const domain = process.argv[2] || "comment.example.com";
const adminPassword = randomBytes(18).toString("base64url");
const sessionSecret = randomBytes(48).toString("base64url");
const encryptionKey = randomBytes(32).toString("base64");
const webhookToken = randomBytes(32).toString("base64url");
const databasePassword = randomBytes(24).toString("base64url");

let value = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
value = value
  .replaceAll("comment.example.com", domain)
  .replace("replace-with-a-long-random-password", adminPassword)
  .replace("replace-with-at-least-32-random-characters", sessionSecret)
  .replace("replace-with-32-random-bytes-in-base64", encryptionKey)
  .replace("replace-with-a-random-webhook-token", webhookToken)
  .replaceAll("replace-with-a-random-database-password", databasePassword);
writeFileSync(target, value, { mode: 0o600 });

console.log(`Created .env for ${domain}`);
console.log(`Admin password: ${adminPassword}`);
console.log("Store this password in a password manager. It will not be shown again.");
