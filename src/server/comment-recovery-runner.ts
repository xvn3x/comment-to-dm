import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { enqueueComment } from "./automation.js";
import { recoverCommentPass } from "./comment-recovery.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { MetaClient } from "./meta.js";
import { retryDecision } from "./rate-control.js";
import type { RuleRecord } from "./rules.js";
import type { SecretBox } from "./security.js";

type Claimed = {
  ig_user_id: string; token_enc: string; graph_version: string;
  started_at: Date; connected_at: Date | null; cursor: unknown;
};

/** Bounded reader, separate from the sending worker and its heartbeat. */
export function startCommentRecovery(sql: Db, config: AppConfig, meta: MetaClient, box: SecretBox) {
  if (!config.COMMENT_RECOVERY_ENABLED || config.META_MODE !== "live") return async () => {};
  let stopped = false;
  let running: Promise<void> | undefined;
  const owner = randomUUID();
  const interval = config.COMMENT_RECOVERY_INTERVAL_SECONDS;
  const leaseSeconds = Math.max(45, Math.ceil(config.META_REQUEST_TIMEOUT_MS / 1000) + 30);
  const pass = async () => {
    await sql`INSERT INTO comment_recovery_state (singleton, ig_user_id)
      SELECT TRUE, ig_user_id FROM meta_connection WHERE singleton AND ig_user_id IS NOT NULL
        AND token_enc IS NOT NULL AND EXISTS (SELECT 1 FROM rules WHERE active AND trigger_type = 'comment')
      ON CONFLICT (singleton) DO UPDATE SET ig_user_id = EXCLUDED.ig_user_id,
        started_at = NOW(), next_scan_at = NOW(), cursor = '{}'::jsonb,
        lease_owner = NULL, lease_until = NULL, updated_at = NOW()
      WHERE comment_recovery_state.ig_user_id <> EXCLUDED.ig_user_id`;
    const rows = await sql<Claimed[]>`WITH candidate AS (
      SELECT s.singleton FROM comment_recovery_state s JOIN meta_connection a ON a.singleton = s.singleton
      WHERE s.next_scan_at <= NOW() AND (s.lease_until IS NULL OR s.lease_until < NOW())
        AND a.ig_user_id = s.ig_user_id AND a.token_enc IS NOT NULL AND NOT a.outbound_paused
        AND a.health_state IN ('healthy', 'degraded', 'rate_limited')
        AND (a.rate_limited_until IS NULL OR a.rate_limited_until <= NOW())
        AND (a.next_health_probe_at IS NULL OR a.next_health_probe_at <= NOW())
        AND EXISTS (SELECT 1 FROM rules WHERE active AND trigger_type = 'comment')
      FOR UPDATE OF s SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE comment_recovery_state s SET lease_owner = ${owner},
        lease_until = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        next_scan_at = NOW() + (${interval} * INTERVAL '1 second'), updated_at = NOW()
      FROM candidate c WHERE s.singleton = c.singleton RETURNING s.*
    ) SELECT c.*, a.token_enc, a.connected_at, a.graph_version FROM claimed c
      JOIN meta_connection a ON a.singleton = c.singleton`;
    const account = rows[0];
    if (!account) return;
    let waitSeconds = interval;
    let errorCode: string | null = null;
    try {
      const rules = await sql<RuleRecord[]>`SELECT * FROM rules WHERE active AND trigger_type = 'comment'
        ORDER BY priority, created_at`;
      const activeMedia = rules.some((r) => r.target_scope === 'all')
        ? await sql<{ media_id: string }[]>`SELECT DISTINCT media_id FROM events
            WHERE trigger_type = 'comment' AND created_at > NOW() - INTERVAL '7 days'` : [];
      const result = await recoverCommentPass({ meta,
        context: { igUserId: account.ig_user_id, token: box.open(account.token_enc), graphVersion: account.graph_version },
        rules, seedMediaIds: [...rules.flatMap((r) => r.media_id ? [r.media_id] : []), ...activeMedia.map((m) => m.media_id)],
        startedAt: new Date(Math.max(account.started_at.getTime(), account.connected_at?.getTime() ?? 0)),
        cursor: account.cursor, requestBudget: config.COMMENT_RECOVERY_REQUEST_BUDGET,
        io: {
          beforeRead: async () => {
            if (stopped) throw new Error('recovery_stopped');
            await delay(250);
            if (stopped) throw new Error('recovery_stopped');
            const held = await sql`UPDATE comment_recovery_state s
              SET lease_until = NOW() + (${leaseSeconds} * INTERVAL '1 second')
              FROM meta_connection a WHERE s.singleton AND s.lease_owner = ${owner} AND s.lease_until > NOW()
                AND a.singleton AND a.ig_user_id = ${account.ig_user_id} AND a.token_enc = ${account.token_enc}
                AND date_trunc('milliseconds', a.connected_at) IS NOT DISTINCT FROM ${account.connected_at}
                AND NOT a.outbound_paused AND a.health_state IN ('healthy', 'degraded', 'rate_limited')
                AND (a.rate_limited_until IS NULL OR a.rate_limited_until <= NOW())
                AND (a.next_health_probe_at IS NULL OR a.next_health_probe_at <= NOW()) RETURNING s.singleton`;
            if (!held.length) throw new Error('recovery_lease_or_connection_changed');
          },
          usage: async (percent) => {
            await sql`UPDATE meta_connection SET last_meta_usage_percent = ${Math.ceil(percent)},
              last_meta_response_at = NOW() WHERE singleton`;
          },
          save: async (cursor) => {
            const saved = await sql`UPDATE comment_recovery_state SET cursor = ${sql.json(cursor)}, updated_at = NOW()
              WHERE singleton AND lease_owner = ${owner} AND lease_until > NOW() RETURNING singleton`;
            if (!saved.length) throw new Error('recovery_lease_lost');
          },
          seen: async (commentId) => (await sql`SELECT id FROM events WHERE comment_id = ${commentId} LIMIT 1`).length > 0,
          enqueue: async (comment, rule, alreadyReplied) => {
            await enqueueComment(sql, comment, { publicBaseUrl: config.PUBLIC_BASE_URL,
              recovery: { igUserId: account.ig_user_id, commentCreatedAt: comment.timestamp, ruleId: rule.id,
                ruleUpdatedAt: rule.updated_at.toISOString(), alreadyReplied } });
          },
        },
      });
      if (result.highUsage) waitSeconds = Math.max(interval, 900);
    } catch (error) {
      // No API URLs, access tokens or incoming text in persisted error messages.
      const decision = retryDecision(error, 1);
      errorCode = `recovery_${decision.action}`;
      waitSeconds = Math.max(interval, decision.delaySeconds, 900);
      if (decision.action === 'rate_limit') {
        await sql`UPDATE meta_connection SET rate_limited_until = NOW() + (${waitSeconds} * INTERVAL '1 second'),
          health_state = 'rate_limited', rate_limit_reason = 'Meta rate limit during comment recovery.' WHERE singleton`;
      }
      const blockedState = decision.action === 'pause_auth' ? 'reauth_required'
        : decision.action === 'pause_permission' ? 'permission_required'
          : decision.action === 'pause_restricted' ? 'restricted' : null;
      if (blockedState) {
        await sql`UPDATE meta_connection SET health_state = ${blockedState},
          health_reason = 'Meta access needs attention during comment recovery.', health_since = NOW(),
          next_health_probe_at = NOW() + (${waitSeconds} * INTERVAL '1 second')
          WHERE singleton AND token_enc = ${account.token_enc}`;
      }
    } finally {
      await sql`UPDATE comment_recovery_state SET lease_owner = NULL, lease_until = NULL,
        next_scan_at = NOW() + (${waitSeconds} * INTERVAL '1 second'),
        last_scan_at = CASE WHEN ${errorCode === null} THEN NOW() ELSE last_scan_at END,
        last_error_code = ${errorCode}, updated_at = NOW() WHERE singleton AND lease_owner = ${owner}`;
    }
  };
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = pass().catch(() => { /* The lease expires after database outages; the cursor stays durable. */ })
      .finally(() => { running = undefined; });
  }, 5000);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
