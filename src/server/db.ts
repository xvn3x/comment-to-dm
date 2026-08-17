import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

const baseSchema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta_connection (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  app_id TEXT,
  app_secret_enc TEXT,
  graph_version TEXT NOT NULL DEFAULT 'v25.0',
  ig_user_id TEXT,
  username TEXT,
  token_enc TEXT,
  token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  outbound_paused BOOLEAN NOT NULL DEFAULT FALSE,
  rate_limited_until TIMESTAMPTZ,
  rate_limit_reason TEXT,
  consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
  consecutive_api_failures INTEGER NOT NULL DEFAULT 0,
  last_meta_usage_percent INTEGER,
  last_meta_response_at TIMESTAMPTZ,
  health_state TEXT NOT NULL DEFAULT 'healthy',
  health_reason TEXT,
  health_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_health_probe_at TIMESTAMPTZ,
  token_refresh_error TEXT,
  token_refresh_failures INTEGER NOT NULL DEFAULT 0,
  subscription_healthy BOOLEAN,
  subscription_last_checked_at TIMESTAMPTZ,
  worker_heartbeat_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  last_webhook_error TEXT,
  unparsed_webhooks INTEGER NOT NULL DEFAULT 0,
  surge_mode BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS worker_leases (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  owner_id UUID,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  target_scope TEXT NOT NULL CHECK (target_scope IN ('all', 'specific')),
  media_id TEXT,
  match_mode TEXT NOT NULL CHECK (match_mode IN ('any', 'contains', 'exact')),
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  public_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  public_replies JSONB NOT NULL DEFAULT '[]'::jsonb,
  dm_text TEXT NOT NULL,
  button_text TEXT,
  button_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((target_scope = 'all' AND media_id IS NULL) OR (target_scope = 'specific' AND media_id IS NOT NULL)),
  CHECK ((button_text IS NULL AND button_url IS NULL) OR (button_text IS NOT NULL AND button_url IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS rules_match_idx ON rules (active, priority, created_at);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  comment_id TEXT NOT NULL UNIQUE,
  media_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  username TEXT,
  rule_id UUID REFERENCES rules(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS events_recent_idx ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS events_dedupe_idx ON events (sender_id, media_id, rule_id, status);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('public_reply', 'private_reply')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'retry_wait', 'uncertain', 'sent', 'failed', 'dead_letter', 'expired', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  ambiguous_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatch_started_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_code TEXT,
  last_error_action TEXT,
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, kind)
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (status, next_attempt_at, created_at);
`;

const migrations = [
  {
    version: 3,
    sql: `
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS outbound_paused BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS rate_limited_until TIMESTAMPTZ;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS rate_limit_reason TEXT;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS consecutive_rate_limits INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS consecutive_api_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS last_meta_usage_percent INTEGER;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS last_meta_response_at TIMESTAMPTZ;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS health_state TEXT NOT NULL DEFAULT 'healthy';
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS health_reason TEXT;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS health_since TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS next_health_probe_at TIMESTAMPTZ;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS token_refresh_error TEXT;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS token_refresh_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS subscription_healthy BOOLEAN;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS subscription_last_checked_at TIMESTAMPTZ;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS last_webhook_error TEXT;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS unparsed_webhooks INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meta_connection ADD COLUMN IF NOT EXISTS surge_mode BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS worker_leases (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        owner_id UUID,
        expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ambiguous_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error_code TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error_action TEXT;
      ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
        CHECK (status IN ('queued', 'processing', 'retry_wait', 'uncertain', 'sent', 'failed', 'dead_letter', 'expired', 'skipped'));
    `,
  },
];

export async function createDb(databaseUrl: string): Promise<Db> {
  const sql = postgres(databaseUrl, { max: 8, idle_timeout: 20, connect_timeout: 15 });
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('commentdm-schema-migrations'))`;
    const existing = await tx<{ present: boolean }[]>`
      SELECT to_regclass('public.meta_connection') IS NOT NULL AS present
    `;
    await tx.unsafe(baseSchema);
    if (!existing[0]?.present) {
      for (const migration of migrations) {
        await tx`INSERT INTO schema_migrations (version) VALUES (${migration.version}) ON CONFLICT DO NOTHING`;
      }
    }
    const applied = await tx<{ version: number }[]>`SELECT version FROM schema_migrations`;
    const versions = new Set(applied.map((row) => row.version));
    for (const migration of migrations) {
      if (versions.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (version) VALUES (${migration.version})`;
    }
    await tx`INSERT INTO meta_connection (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING`;
    await tx`INSERT INTO worker_leases (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING`;
  });
  return sql;
}
