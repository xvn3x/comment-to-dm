import assert from "node:assert/strict";
import postgres from "postgres";
import { createDb } from "../src/server/db.js";
import { requireDisposableDatabase } from "./test-db-guard.mjs";

// Скрипт выполняет DROP SCHEMA public CASCADE, поэтому та же защита, что и у integration.
const { url: databaseUrl } = requireDisposableDatabase({
  variable: "INTEGRATION_DATABASE_URL",
  command: "npm run test:migration",
});

const oldSchema = `
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE TABLE meta_connection (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), app_id TEXT, app_secret_enc TEXT,
  graph_version TEXT NOT NULL DEFAULT 'v25.0', ig_user_id TEXT, username TEXT, token_enc TEXT,
  token_expires_at TIMESTAMPTZ, connected_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outbound_paused BOOLEAN NOT NULL DEFAULT FALSE, rate_limited_until TIMESTAMPTZ, rate_limit_reason TEXT,
  consecutive_rate_limits INTEGER NOT NULL DEFAULT 0, last_meta_usage_percent INTEGER, last_meta_response_at TIMESTAMPTZ
);
CREATE TABLE rules (
  id UUID PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, priority INTEGER NOT NULL DEFAULT 100,
  target_scope TEXT NOT NULL CHECK (target_scope IN ('all', 'specific')), media_id TEXT,
  match_mode TEXT NOT NULL CHECK (match_mode IN ('any', 'contains', 'exact')), keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  public_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE, public_replies JSONB NOT NULL DEFAULT '[]'::jsonb,
  dm_text TEXT NOT NULL, button_text TEXT, button_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((target_scope = 'all' AND media_id IS NULL) OR (target_scope = 'specific' AND media_id IS NOT NULL)),
  CHECK ((button_text IS NULL AND button_url IS NULL) OR (button_text IS NOT NULL AND button_url IS NOT NULL))
);
CREATE TABLE events (
  id UUID PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, media_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  username TEXT, rule_id UUID REFERENCES rules(id) ON DELETE SET NULL, status TEXT NOT NULL, error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ
);
CREATE TABLE jobs (
  id UUID PRIMARY KEY, event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('public_reply', 'private_reply')), payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'retry_wait', 'sent', 'failed', 'dead_letter', 'expired', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT,
  external_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, kind)
);
INSERT INTO meta_connection (singleton, app_id, username) VALUES (TRUE, 'preserved-app', 'preserved-account');
INSERT INTO rules (
  id, name, target_scope, media_id, match_mode, keywords,
  public_reply_enabled, public_replies, dm_text
) VALUES (
  '00000000-0000-4000-8000-000000000099', 'Preserved rule', 'all', NULL, 'contains', '["guide"]'::jsonb,
  TRUE, '["Sent to Direct"]'::jsonb, 'Legacy Direct message'
);
INSERT INTO events (id, comment_id, media_id, sender_id, username, rule_id, status, created_at, processed_at)
VALUES (
  '00000000-0000-4000-8000-0000000000a1', 'legacy-comment-1', 'legacy-media', 'legacy-sender', 'legacy_user',
  '00000000-0000-4000-8000-000000000099', 'sent', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'
);
INSERT INTO jobs (id, event_id, kind, payload, status, attempts, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'public_reply',
  '{"message":"legacy"}'::jsonb, 'sent', 1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'
);
`;

const seed = postgres(databaseUrl, { max: 1 });
await seed.unsafe(oldSchema);
await seed.end();

const sql = await createDb(databaseUrl);
try {
  const connection = await sql`SELECT app_id, username, health_state, surge_mode FROM meta_connection WHERE singleton = TRUE`;
  assert.equal(connection[0].app_id, "preserved-app");
  assert.equal(connection[0].username, "preserved-account");
  assert.equal(connection[0].health_state, "healthy");
  assert.equal(connection[0].surge_mode, false);
  const [preservedRule] = await sql`
    SELECT name, direct_message_enabled, dm_text FROM rules
    WHERE id = '00000000-0000-4000-8000-000000000099'
  `;
  assert.deepEqual(preservedRule, {
    name: "Preserved rule",
    direct_message_enabled: true,
    dm_text: "Legacy Direct message",
  });
  const migrations = await sql`SELECT version FROM schema_migrations WHERE version IN (3, 4, 5, 6, 7, 8, 9) ORDER BY version`;
  assert.deepEqual(migrations.map((row) => row.version), [3, 4, 5, 6, 7, 8, 9]);
  const rulesColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'rules' AND column_name IN ('follow_gate_enabled', 'direct_message_enabled')
  `;
  assert.equal(rulesColumns.length, 2);
  const sessions = await sql`SELECT to_regclass('public.follow_gate_sessions') AS name`;
  assert.equal(sessions[0].name, 'follow_gate_sessions');
  const followUps = await sql`SELECT to_regclass('public.follow_up_sessions') AS name`;
  assert.equal(followUps[0].name, 'follow_up_sessions');
  const linkTracking = await sql`SELECT to_regclass('public.link_tracking') AS name`;
  assert.equal(linkTracking[0].name, 'link_tracking');
  const lease = await sql`SELECT singleton FROM worker_leases WHERE singleton = TRUE`;
  assert.equal(lease.length, 1);
  const analyticsIndexes = await sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN (
      'jobs_delivery_analytics_idx', 'events_failed_recent_idx',
      'follow_gate_sessions_created_idx', 'follow_up_sessions_sent_idx',
      'link_tracking_delivered_idx'
    )
    ORDER BY indexname
  `;
  assert.deepEqual(analyticsIndexes.map((row) => row.indexname), [
    "events_failed_recent_idx", "follow_gate_sessions_created_idx",
    "follow_up_sessions_sent_idx", "jobs_delivery_analytics_idx", "link_tracking_delivered_idx",
  ]);
  const events = await sql`SELECT COUNT(*)::int AS total FROM events`;
  assert.equal(events[0].total, 1, "Existing history must survive the migration");
  const jobs = await sql`SELECT status, kind FROM jobs`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "sent");
  console.log("Migration v0.2 → current passed without losing Meta connection data.");
} finally {
  await sql.end();
}
