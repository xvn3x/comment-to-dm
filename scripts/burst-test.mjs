import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
const count = Number(process.argv[3] || 5000);
const concurrency = Number(process.argv[4] || 25);
const password = process.env.BURST_ADMIN_PASSWORD;

if (!password) throw new Error("Set BURST_ADMIN_PASSWORD before running the burst test.");
if (!Number.isInteger(count) || count < 1 || count > 50_000) throw new Error("Count must be between 1 and 50000.");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new Error("Concurrency must be between 1 and 100.");

const session = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
if (session.metaMode !== "mock") throw new Error("Burst test is disabled unless META_MODE=mock.");

const login = await fetch(`${baseUrl}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
assert.equal(login.status, 200, "Admin login failed");
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "Session cookie is missing");

let next = 0;
let accepted = 0;
const started = performance.now();

async function producer() {
  while (true) {
    const index = next++;
    if (index >= count) return;
    const response = await fetch(`${baseUrl}/api/mock/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "гайд", mediaId: "demo-reel-1", username: `burst_${index}_${Date.now()}` }),
    });
    assert.equal(response.status, 200, `Comment ${index} returned HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.result, "queued", `Comment ${index} was not queued`);
    accepted += 1;
  }
}

await Promise.all(Array.from({ length: concurrency }, () => producer()));
const elapsedSeconds = (performance.now() - started) / 1000;
const dashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: cookie } }).then((response) => response.json());

assert.equal(accepted, count);
assert.ok(dashboard.queue.pending > 0 || dashboard.stats.sent_24h > 0, "No queued or completed jobs found");
console.log(JSON.stringify({
  accepted,
  elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
  ingressPerSecond: Number((accepted / elapsedSeconds).toFixed(1)),
  queue: dashboard.queue,
}, null, 2));
