import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { MetaApiError, MetaClient } from "./meta.js";
import { adaptiveIntervalMs, retryDecision, withJitter } from "./rate-control.js";
import { SecretBox } from "./security.js";

type Job = {
  id: string;
  event_id: string;
  kind: "public_reply" | "private_reply";
  payload: {
    commentId: string;
    message: string;
    button?: { title: string; url: string };
  };
  attempts: number;
  created_at: Date;
};

type Connection = {
  ig_user_id: string | null;
  token_enc: string | null;
  graph_version: string;
  token_expires_at?: Date | null;
  outbound_paused: boolean;
  rate_limited_until: Date | null;
  consecutive_rate_limits: number;
  last_meta_usage_percent: number | null;
};

async function finishEvent(sql: Db, eventId: string): Promise<void> {
  const pending = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM jobs
    WHERE event_id = ${eventId} AND status IN ('queued', 'processing', 'retry_wait')
  `;
  if (pending[0]?.count) return;
  const failures = await sql<{ count: number; error: string | null }[]>`
    SELECT COUNT(*)::int AS count, MAX(last_error) AS error FROM jobs
    WHERE event_id = ${eventId} AND status IN ('failed', 'dead_letter', 'expired')
  `;
  await sql`
    UPDATE events
    SET status = ${failures[0]?.count ? "failed" : "sent"},
        error_message = ${failures[0]?.error ?? null}, processed_at = NOW()
    WHERE id = ${eventId}
  `;
}

async function claimJob(sql: Db, preferPublic: boolean): Promise<Job | undefined> {
  const rows = await sql<Job[]>`
    UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status IN ('queued', 'retry_wait') AND next_attempt_at <= NOW()
      ORDER BY CASE kind WHEN ${preferPublic ? "public_reply" : "private_reply"} THEN 0 ELSE 1 END,
               next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, event_id, kind, payload, attempts, created_at
  `;
  return rows[0];
}

function millisecondsUntil(date: Date): number {
  return Math.max(250, Math.min(60_000, date.getTime() - Date.now()));
}

export function startWorker(sql: Db, config: AppConfig, meta: MetaClient, box: SecretBox) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let privateStreak = 0;

  const tick = async () => {
    if (stopped) return;
    let nextDelay = config.QUEUE_INTERVAL_MS;
    let job: Job | undefined;
    try {
      const connections = await sql<Connection[]>`
        SELECT ig_user_id, token_enc, graph_version, outbound_paused, rate_limited_until,
               consecutive_rate_limits, last_meta_usage_percent
        FROM meta_connection WHERE singleton = TRUE
      `;
      const connection = connections[0];
      if (!connection?.ig_user_id || !connection.token_enc || connection.outbound_paused) {
        nextDelay = 2_000;
        return;
      }
      if (connection.rate_limited_until && connection.rate_limited_until.getTime() > Date.now()) {
        nextDelay = millisecondsUntil(connection.rate_limited_until);
        return;
      }

      job = await claimJob(sql, privateStreak >= 4);
      if (!job) {
        nextDelay = 1_000;
        return;
      }

      if (job.kind === "private_reply" && job.created_at.getTime() < Date.now() - 7 * 86_400_000) {
        await sql`
          UPDATE jobs SET status = 'expired', last_error = 'Private reply eligibility window expired.', updated_at = NOW()
          WHERE id = ${job.id}
        `;
        await finishEvent(sql, job.event_id);
        return;
      }

      const context = {
        igUserId: connection.ig_user_id,
        token: box.open(connection.token_enc),
        graphVersion: connection.graph_version,
      };
      const result = job.kind === "public_reply"
        ? await meta.publicReply(context, job.payload.commentId, job.payload.message)
        : await meta.privateReply(context, job.payload.commentId, job.payload.message, job.payload.button);

      await sql.begin(async (tx) => {
        await tx`
          UPDATE jobs SET status = 'sent', external_id = ${result.externalId}, last_error = NULL, updated_at = NOW()
          WHERE id = ${job!.id}
        `;
        await tx`
          UPDATE meta_connection
          SET last_meta_usage_percent = ${result.usagePercent ?? Math.max(0, (connection.last_meta_usage_percent ?? 0) - 5)},
              last_meta_response_at = NOW(),
              rate_limited_until = CASE
                WHEN ${result.usagePercent ?? 0} >= 95 THEN NOW() + INTERVAL '60 seconds'
                WHEN rate_limited_until <= NOW() THEN NULL ELSE rate_limited_until END,
              rate_limit_reason = CASE
                WHEN ${result.usagePercent ?? 0} >= 95 THEN 'Meta usage reached 95%; proactive safety pause.'
                WHEN rate_limited_until <= NOW() THEN NULL ELSE rate_limit_reason END,
              consecutive_rate_limits = GREATEST(consecutive_rate_limits - 1, 0), updated_at = NOW()
          WHERE singleton = TRUE
        `;
      });
      await finishEvent(sql, job.event_id);
      privateStreak = job.kind === "private_reply" ? privateStreak + 1 : 0;
      nextDelay = (result.usagePercent ?? 0) >= 95
        ? 60_000
        : adaptiveIntervalMs(config.QUEUE_INTERVAL_MS, result.usagePercent ?? connection.last_meta_usage_percent);
    } catch (error) {
      if (job) {
        const connectionRows = await sql<{ consecutive_rate_limits: number }[]>`
          SELECT consecutive_rate_limits FROM meta_connection WHERE singleton = TRUE
        `;
        const decision = retryDecision(error, job.attempts, connectionRows[0]?.consecutive_rate_limits ?? 0);
        const delaySeconds = withJitter(decision.delaySeconds);
        const exhausted = !decision.rateLimited && job.attempts >= config.JOB_MAX_ATTEMPTS;
        const retry = decision.retryable && !exhausted;
        const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown worker error";

        await sql.begin(async (tx) => {
          await tx`
            UPDATE jobs
            SET status = ${retry ? "retry_wait" : "dead_letter"},
                attempts = ${decision.rateLimited ? sql`GREATEST(attempts - 1, 0)` : sql`attempts`},
                next_attempt_at = NOW() + (${delaySeconds} * INTERVAL '1 second'),
                last_error = ${message}, updated_at = NOW()
            WHERE id = ${job!.id}
          `;
          if (decision.rateLimited) {
            const metaError = error as MetaApiError;
            await tx`
              UPDATE meta_connection
              SET rate_limited_until = NOW() + (${delaySeconds} * INTERVAL '1 second'),
                  rate_limit_reason = ${`Meta rate limit${metaError.code ? ` (${metaError.code})` : ""}: ${message}`},
                  consecutive_rate_limits = consecutive_rate_limits + 1,
                  last_meta_usage_percent = COALESCE(${metaError.usagePercent ?? null}, last_meta_usage_percent),
                  last_meta_response_at = NOW(), updated_at = NOW()
              WHERE singleton = TRUE
            `;
          }
        });
        if (!retry) await finishEvent(sql, job.event_id);
        nextDelay = decision.rateLimited
          ? millisecondsUntil(new Date(Date.now() + delaySeconds * 1000))
          : config.QUEUE_INTERVAL_MS;
      }
    } finally {
      timer = setTimeout(tick, nextDelay);
      timer.unref();
    }
  };

  void sql`UPDATE jobs SET status = 'retry_wait', next_attempt_at = NOW() WHERE status = 'processing'`
    .then(() => tick());

  const maintenance = setInterval(() => {
    void sql`DELETE FROM events WHERE created_at < NOW() - INTERVAL '30 days'`;
    void sql`DELETE FROM oauth_states WHERE expires_at < NOW()`;
    void sql`
      WITH expired AS (
        UPDATE jobs SET status = 'expired', last_error = 'Private reply eligibility window expired.', updated_at = NOW()
        WHERE kind = 'private_reply' AND status IN ('queued', 'retry_wait')
          AND created_at < NOW() - INTERVAL '7 days'
        RETURNING event_id
      )
      UPDATE events SET status = 'failed', error_message = 'Private reply eligibility window expired.', processed_at = NOW()
      WHERE id IN (SELECT event_id FROM expired)
    `;
  }, 3_600_000);
  maintenance.unref();

  const refreshExpiringToken = async () => {
    const rows = await sql<Connection[]>`
      SELECT ig_user_id, token_enc, graph_version, token_expires_at, outbound_paused,
             rate_limited_until, consecutive_rate_limits, last_meta_usage_percent
      FROM meta_connection WHERE singleton = TRUE
    `;
    const connection = rows[0];
    if (!connection?.ig_user_id || !connection.token_enc || !connection.token_expires_at) return;
    if (connection.token_expires_at.getTime() > Date.now() + 7 * 86_400_000) return;
    try {
      const refreshed = await meta.refreshToken({
        igUserId: connection.ig_user_id,
        token: box.open(connection.token_enc),
        graphVersion: connection.graph_version,
      });
      await sql`
        UPDATE meta_connection SET token_enc = ${box.seal(refreshed.accessToken)},
          token_expires_at = ${refreshed.expiresIn ? sql`NOW() + (${refreshed.expiresIn} * INTERVAL '1 second')` : connection.token_expires_at},
          updated_at = NOW()
        WHERE singleton = TRUE
      `;
    } catch {
      // Keep the still-valid token. Its expiry remains visible in the dashboard.
    }
  };
  void refreshExpiringToken();
  const refreshTimer = setInterval(() => void refreshExpiringToken(), 43_200_000);
  refreshTimer.unref();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(maintenance);
    clearInterval(refreshTimer);
  };
}
