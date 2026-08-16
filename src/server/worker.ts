import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { MetaApiError, MetaClient } from "./meta.js";
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
};

type Connection = {
  ig_user_id: string | null;
  token_enc: string | null;
  graph_version: string;
  token_expires_at?: Date | null;
};

async function finishEvent(sql: Db, eventId: string): Promise<void> {
  const pending = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM jobs
    WHERE event_id = ${eventId} AND status IN ('queued', 'processing')
  `;
  if (pending[0]?.count) return;
  const failures = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM jobs WHERE event_id = ${eventId} AND status = 'failed'
  `;
  await sql`
    UPDATE events SET status = ${failures[0]?.count ? "failed" : "sent"}, processed_at = NOW()
    WHERE id = ${eventId}
  `;
}

async function claimJob(sql: Db): Promise<Job | undefined> {
  const rows = await sql<Job[]>`
    UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, event_id, kind, payload, attempts
  `;
  return rows[0];
}

export function startWorker(sql: Db, config: AppConfig, meta: MetaClient, box: SecretBox) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const job = await claimJob(sql);
      if (job) {
        const connections = await sql<Connection[]>`
          SELECT ig_user_id, token_enc, graph_version FROM meta_connection WHERE singleton = TRUE
        `;
        const connection = connections[0];
        if (!connection?.ig_user_id || !connection.token_enc) {
          throw new MetaApiError("Instagram account is not connected.", 409);
        }
        const context = {
          igUserId: connection.ig_user_id,
          token: box.open(connection.token_enc),
          graphVersion: connection.graph_version,
        };
        const externalId = job.kind === "public_reply"
          ? await meta.publicReply(context, job.payload.commentId, job.payload.message)
          : await meta.privateReply(context, job.payload.commentId, job.payload.message, job.payload.button);
        await sql`
          UPDATE jobs SET status = 'sent', external_id = ${externalId}, last_error = NULL, updated_at = NOW()
          WHERE id = ${job.id}
        `;
        await finishEvent(sql, job.event_id);
      }
    } catch (error) {
      const jobRows = await sql<Job[]>`
        SELECT id, event_id, kind, payload, attempts FROM jobs
        WHERE status = 'processing' ORDER BY updated_at DESC LIMIT 1
      `;
      const job = jobRows[0];
      if (job) {
        const metaError = error instanceof MetaApiError ? error : undefined;
        const retryable = Boolean(metaError?.status === 429 || (metaError?.status ?? 0) >= 500 || metaError?.transient);
        const retry = retryable && job.attempts < config.JOB_MAX_ATTEMPTS;
        const delaySeconds = metaError?.status === 429 ? 60 : Math.min(900, 2 ** job.attempts);
        await sql`
          UPDATE jobs
          SET status = ${retry ? "queued" : "failed"},
              next_attempt_at = NOW() + (${delaySeconds} * INTERVAL '1 second'),
              last_error = ${error instanceof Error ? error.message.slice(0, 1000) : "Unknown worker error"},
              updated_at = NOW()
          WHERE id = ${job.id}
        `;
        if (!retry) await finishEvent(sql, job.event_id);
      }
    } finally {
      timer = setTimeout(tick, config.QUEUE_INTERVAL_MS);
      timer.unref();
    }
  };

  void sql`UPDATE jobs SET status = 'queued', next_attempt_at = NOW() WHERE status = 'processing'`
    .then(() => tick());

  const cleanup = setInterval(() => {
    void sql`DELETE FROM events WHERE created_at < NOW() - INTERVAL '30 days'`;
    void sql`DELETE FROM oauth_states WHERE expires_at < NOW()`;
  }, 3_600_000);
  cleanup.unref();

  const refreshExpiringToken = async () => {
    const rows = await sql<Connection[]>`
      SELECT ig_user_id, token_enc, graph_version, token_expires_at
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
      // A failed refresh does not discard a still-valid token. The dashboard exposes its expiry.
    }
  };
  void refreshExpiringToken();
  const refreshTimer = setInterval(() => void refreshExpiringToken(), 43_200_000);
  refreshTimer.unref();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(cleanup);
    clearInterval(refreshTimer);
  };
}
