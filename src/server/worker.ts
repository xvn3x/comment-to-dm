import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { MetaApiError, MetaClient, type SendContext } from "./meta.js";
import { adaptiveIntervalMs, retryDecision, withJitter, type RetryDecision } from "./rate-control.js";
import { SecretBox } from "./security.js";

type Job = {
  id: string;
  event_id: string;
  kind: "public_reply" | "private_reply" | "direct_message" | "follow_check" | "follow_up";
  payload: {
    commentId?: string;
    scopedUserId?: string;
    message?: string;
    button?: { title: string; url: string };
    quickReply?: { title: string; payload: string };
    followGate?: boolean;
    scheduleFollowUp?: boolean;
    sessionStatus?: "awaiting_follow" | "delivered";
    expiresAt?: string;
  };
  attempts: number;
  ambiguous_attempts: number;
  created_at: Date;
};

type HealthState = "healthy" | "degraded" | "rate_limited" | "reauth_required" | "permission_required" | "restricted" | "misconfigured";

type Connection = {
  ig_user_id: string | null;
  token_enc: string | null;
  graph_version: string;
  token_expires_at: Date | null;
  outbound_paused: boolean;
  rate_limited_until: Date | null;
  consecutive_rate_limits: number;
  consecutive_api_failures: number;
  last_meta_usage_percent: number | null;
  health_state: HealthState;
  next_health_probe_at: Date | null;
  subscription_healthy: boolean | null;
  subscription_last_checked_at: Date | null;
  surge_mode: boolean;
};

const BLOCKED_STATES = new Set<HealthState>(["reauth_required", "permission_required", "misconfigured"]);

async function finishEvent(sql: Db, eventId: string): Promise<void> {
  const pending = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM jobs
    WHERE event_id = ${eventId} AND status IN ('queued', 'processing', 'retry_wait', 'uncertain')
      AND affects_event_status = TRUE
  `;
  if (pending[0]?.count) return;
  const failures = await sql<{ count: number; error: string | null }[]>`
    SELECT COUNT(*)::int AS count, MAX(last_error) AS error FROM jobs
    WHERE event_id = ${eventId} AND status IN ('failed', 'dead_letter', 'expired')
      AND affects_event_status = TRUE
  `;
  await sql`
    UPDATE events SET status = ${failures[0]?.count ? "failed" : "sent"},
      error_message = ${failures[0]?.error ?? null}, processed_at = NOW()
    WHERE id = ${eventId}
  `;
}

async function claimJob(sql: Db, preferPublic: boolean): Promise<Job | undefined> {
  const rows = await sql<Job[]>`
    WITH candidate AS (
      SELECT id FROM jobs
      WHERE status IN ('queued', 'retry_wait', 'uncertain') AND next_attempt_at <= NOW()
      ORDER BY CASE
                 WHEN kind = 'direct_message' THEN 0
                 WHEN kind = 'follow_check' THEN 1
                 WHEN kind = ${preferPublic ? "public_reply" : "private_reply"} THEN 2
                 ELSE 3
               END,
               next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE jobs AS job SET status = 'processing', attempts = attempts + 1,
      dispatch_started_at = NOW(), updated_at = NOW()
    FROM candidate WHERE job.id = candidate.id
    RETURNING job.id, job.event_id, job.kind, job.payload, job.attempts,
      job.ambiguous_attempts, job.created_at
  `;
  return rows[0];
}

function millisecondsUntil(date: Date): number {
  return Math.max(250, Math.min(60_000, date.getTime() - Date.now()));
}

function jobExpired(job: Job): boolean {
  if (job.payload.expiresAt) return Date.parse(job.payload.expiresAt) <= Date.now();
  return job.created_at.getTime() < Date.now() - 7 * 86_400_000;
}

function trackingTokenFromUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).pathname.match(/^\/r\/([0-9a-f-]{36})$/i)?.[1];
  } catch {
    return undefined;
  }
}

function stateForDecision(decision: RetryDecision): HealthState | undefined {
  if (decision.action === "rate_limit") return "rate_limited";
  if (decision.action === "pause_auth") return "reauth_required";
  if (decision.action === "pause_permission") return "permission_required";
  if (decision.action === "pause_restricted") return "restricted";
  return undefined;
}

export function startWorker(sql: Db, config: AppConfig, meta: MetaClient, box: SecretBox) {
  const ownerId = randomUUID();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let privateStreak = 0;
  let surgeMode = false;
  let lastSurgeCheck = 0;
  let healthCheckRunning = false;
  let leaseRenewAfter = 0;
  let heartbeatAfter = 0;

  const acquireLease = async (): Promise<boolean> => {
    const now = Date.now();
    if (now < leaseRenewAfter) return true;
    const rows = await sql<{ owner_id: string }[]>`
      UPDATE worker_leases SET owner_id = ${ownerId}, expires_at = NOW() + INTERVAL '45 seconds', updated_at = NOW()
      WHERE singleton = TRUE AND (owner_id IS NULL OR owner_id = ${ownerId} OR expires_at < NOW())
      RETURNING owner_id
    `;
    if (!rows.length) {
      leaseRenewAfter = 0;
      return false;
    }
    leaseRenewAfter = now + 15_000;
    if (now >= heartbeatAfter) {
      await sql`UPDATE meta_connection SET worker_heartbeat_at = NOW(), updated_at = NOW() WHERE singleton = TRUE`;
      heartbeatAfter = now + 15_000;
    }
    return true;
  };

  const refreshSurgeMode = async () => {
    if (Date.now() - lastSurgeCheck < 15_000) return;
    lastSurgeCheck = Date.now();
    const rows = await sql<{ pending: number }[]>`
      SELECT COUNT(*)::int AS pending FROM jobs
      WHERE kind IN ('private_reply', 'direct_message', 'follow_check', 'follow_up') AND status IN ('queued', 'processing', 'retry_wait', 'uncertain')
    `;
    const pending = rows[0]?.pending ?? 0;
    if (!surgeMode && pending >= config.SURGE_ENTER_PRIVATE_JOBS) surgeMode = true;
    if (surgeMode && pending <= config.SURGE_EXIT_PRIVATE_JOBS) surgeMode = false;
    await sql`UPDATE meta_connection SET surge_mode = ${surgeMode}, updated_at = NOW() WHERE singleton = TRUE AND surge_mode <> ${surgeMode}`;
  };

  const connectionContext = (connection: Connection): SendContext => ({
    igUserId: connection.ig_user_id!, token: box.open(connection.token_enc!), graphVersion: connection.graph_version,
  });

  const markSent = async (job: Job, externalId: string, usagePercent?: number, recipientId?: string) => {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE jobs SET status = 'sent', external_id = ${externalId}, last_error = NULL,
          last_error_code = NULL, last_error_action = NULL, dispatch_started_at = NULL, updated_at = NOW()
        WHERE id = ${job.id}
      `;
      const trackingToken = trackingTokenFromUrl(job.payload.button?.url);
      if (trackingToken) {
        await tx`
          UPDATE link_tracking SET delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW()
          WHERE tracking_token = ${trackingToken}
        `;
      }
      await tx`
        UPDATE meta_connection SET
          last_meta_usage_percent = ${usagePercent ?? 0}, last_meta_response_at = NOW(),
          rate_limited_until = CASE WHEN rate_limited_until <= NOW() THEN NULL ELSE rate_limited_until END,
          rate_limit_reason = CASE WHEN rate_limited_until <= NOW() THEN NULL ELSE rate_limit_reason END,
          consecutive_rate_limits = GREATEST(consecutive_rate_limits - 1, 0),
          consecutive_api_failures = 0,
          health_state = CASE WHEN health_state IN ('degraded', 'rate_limited', 'restricted') THEN 'healthy' ELSE health_state END,
          health_reason = CASE WHEN health_state IN ('degraded', 'rate_limited', 'restricted') THEN NULL ELSE health_reason END,
          health_since = CASE WHEN health_state IN ('degraded', 'rate_limited', 'restricted') THEN NOW() ELSE health_since END,
          next_health_probe_at = NULL, updated_at = NOW()
        WHERE singleton = TRUE
      `;
      if (job.kind === "private_reply" && job.payload.followGate) {
        await tx`
          UPDATE follow_gate_sessions SET scoped_user_id = COALESCE(${recipientId ?? null}, scoped_user_id),
            status = 'awaiting_interaction', updated_at = NOW()
          WHERE event_id = ${job.event_id}
        `;
      }
      if (job.kind === "direct_message" && job.payload.sessionStatus) {
        await tx`
          UPDATE follow_gate_sessions SET status = ${job.payload.sessionStatus},
            completed_at = ${job.payload.sessionStatus === "delivered" ? tx`NOW()` : null},
            last_error = NULL, updated_at = NOW()
          WHERE event_id = ${job.event_id}
        `;
      }
      if (job.kind === "follow_up") {
        await tx`
          UPDATE follow_up_sessions SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW()
          WHERE event_id = ${job.event_id}
        `;
      }
      if (job.payload.scheduleFollowUp) {
        const sessions = await tx<{
          scoped_user_id: string | null; material_button_text: string; follow_up_text: string;
          tracking_token: string; delay_minutes: number; status: string; clicked_at: Date | null;
        }[]>`
          SELECT scoped_user_id, material_button_text, follow_up_text, tracking_token,
            delay_minutes, status, clicked_at
          FROM follow_up_sessions WHERE event_id = ${job.event_id} FOR UPDATE
        `;
        const session = sessions[0];
        const scopedUserId = session?.scoped_user_id ?? job.payload.scopedUserId ?? recipientId;
        if (session && scopedUserId && session.status === "awaiting_window" && !session.clicked_at) {
          const followUpUrl = new URL(`/r/${session.tracking_token}`, config.PUBLIC_BASE_URL).toString();
          await tx`
            INSERT INTO jobs (id, event_id, kind, interaction_id, payload, affects_event_status, next_attempt_at)
            VALUES (
              ${randomUUID()}, ${job.event_id}, 'follow_up', ${`follow-up:${job.event_id}`},
              ${tx.json({
                scopedUserId,
                message: session.follow_up_text,
                button: { title: session.material_button_text, url: followUpUrl },
                expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
              })}, FALSE, NOW() + (${session.delay_minutes} * INTERVAL '1 minute')
            ) ON CONFLICT DO NOTHING
          `;
          await tx`
            UPDATE follow_up_sessions SET scoped_user_id = ${scopedUserId}, status = 'scheduled',
              scheduled_at = NOW(), last_error = NULL, updated_at = NOW()
            WHERE event_id = ${job.event_id}
          `;
        }
      }
    });
    await finishEvent(sql, job.event_id);
  };

  const completeFollowCheck = async (job: Job, followed: boolean, usagePercent?: number) => {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${job.event_id}, 2))`;
      const sessions = await tx<{
        final_message: string; final_button_text: string | null; final_button_url: string | null;
        check_button_text: string; retry_message: string; status: string;
      }[]>`
        SELECT final_message, final_button_text, final_button_url, check_button_text, retry_message, status
        FROM follow_gate_sessions WHERE event_id = ${job.event_id} FOR UPDATE
      `;
      const session = sessions[0];
      if (!session || session.status === "delivered") {
        await tx`
          UPDATE jobs SET status = 'skipped', external_id = 'follow-session-closed',
            dispatch_started_at = NULL, updated_at = NOW() WHERE id = ${job.id}
        `;
        return;
      }
      const directPayload = followed ? {
        scopedUserId: job.payload.scopedUserId,
        message: session.final_message,
        button: session.final_button_text && session.final_button_url
          ? { title: session.final_button_text, url: session.final_button_url } : undefined,
        sessionStatus: "delivered",
        scheduleFollowUp: true,
        expiresAt: job.payload.expiresAt,
      } : {
        scopedUserId: job.payload.scopedUserId,
        message: session.retry_message,
        quickReply: { title: session.check_button_text, payload: `follow_gate:${job.event_id}` },
        sessionStatus: "awaiting_follow",
        expiresAt: job.payload.expiresAt,
      };
      await tx`
        INSERT INTO jobs (id, event_id, kind, interaction_id, payload)
        VALUES (
          ${randomUUID()}, ${job.event_id}, 'direct_message', ${`follow-response:${job.id}`},
          ${tx.json(directPayload)}
        ) ON CONFLICT DO NOTHING
      `;
      await tx`
        UPDATE jobs SET status = 'sent', external_id = ${followed ? "follow:true" : "follow:false"},
          last_error = NULL, last_error_code = NULL, last_error_action = NULL,
          dispatch_started_at = NULL, updated_at = NOW() WHERE id = ${job.id}
      `;
      await tx`
        UPDATE follow_gate_sessions SET last_checked_at = NOW(),
          status = ${followed ? "awaiting_interaction" : "awaiting_follow"},
          last_error = NULL, updated_at = NOW() WHERE event_id = ${job.event_id}
      `;
      await tx`
        UPDATE meta_connection SET last_meta_usage_percent = ${usagePercent ?? 0},
          last_meta_response_at = NOW(), consecutive_api_failures = 0,
          consecutive_rate_limits = GREATEST(consecutive_rate_limits - 1, 0),
          health_state = CASE WHEN health_state IN ('degraded', 'rate_limited', 'restricted') THEN 'healthy' ELSE health_state END,
          health_reason = CASE WHEN health_state IN ('degraded', 'rate_limited', 'restricted') THEN NULL ELSE health_reason END,
          health_since = CASE WHEN health_state IN ('degraded', 'rate_limited', 'restricted') THEN NOW() ELSE health_since END,
          next_health_probe_at = NULL, updated_at = NOW() WHERE singleton = TRUE
      `;
    });
    await finishEvent(sql, job.event_id);
  };

  const handleJobError = async (job: Job, error: unknown, connection: Connection): Promise<number> => {
    const decision = retryDecision(error, job.attempts, connection.consecutive_rate_limits);
    const isolatedProfileConsent = job.kind === "follow_check"
      && error instanceof MetaApiError && error.status === 409;
    const delaySeconds = withJitter(decision.delaySeconds);
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown delivery error";

    if (decision.assumedSent) {
      await markSent(job, "assumed-already-sent");
      return config.QUEUE_INTERVAL_MS;
    }

    const expired = jobExpired(job);
    const internalExhausted = decision.errorCode === "internal" && job.attempts >= config.JOB_MAX_ATTEMPTS;
    const shouldRetry = decision.retryable && !expired && !internalExhausted;
    const status = expired ? "expired" : shouldRetry ? (decision.action === "uncertain" ? "uncertain" : "retry_wait") : "dead_letter";
    const globalState = stateForDecision(decision);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE jobs SET status = ${status},
          attempts = ${decision.rateLimited || globalState ? tx`GREATEST(attempts - 1, 0)` : tx`attempts`},
          ambiguous_attempts = ambiguous_attempts + ${decision.action === "uncertain" ? 1 : 0},
          next_attempt_at = NOW() + (${delaySeconds} * INTERVAL '1 second'),
          last_error = ${message}, last_error_code = ${decision.errorCode ?? null},
          last_error_action = ${decision.action}, dispatch_started_at = NULL, updated_at = NOW()
        WHERE id = ${job.id}
      `;

      if (globalState) {
        const requiresOwner = globalState === "reauth_required" || globalState === "permission_required";
        await tx`
          UPDATE meta_connection SET health_state = ${globalState}, health_reason = ${message}, health_since = NOW(),
            next_health_probe_at = ${requiresOwner ? null : tx`NOW() + (${delaySeconds} * INTERVAL '1 second')`},
            rate_limited_until = ${globalState === "rate_limited" || globalState === "restricted" ? tx`NOW() + (${delaySeconds} * INTERVAL '1 second')` : null},
            rate_limit_reason = ${globalState === "rate_limited" ? message : null},
            consecutive_rate_limits = consecutive_rate_limits + ${globalState === "rate_limited" ? 1 : 0},
            consecutive_api_failures = consecutive_api_failures + 1, updated_at = NOW()
          WHERE singleton = TRUE
        `;
      } else if (!isolatedProfileConsent && (decision.action === "retry" || decision.action === "uncertain")) {
        await tx`
          UPDATE meta_connection SET consecutive_api_failures = consecutive_api_failures + 1,
            health_state = CASE WHEN consecutive_api_failures + 1 >= 3 THEN 'degraded' ELSE health_state END,
            health_reason = CASE WHEN consecutive_api_failures + 1 >= 3 THEN ${message} ELSE health_reason END,
            health_since = CASE WHEN consecutive_api_failures + 1 >= 3 THEN NOW() ELSE health_since END,
            next_health_probe_at = CASE WHEN consecutive_api_failures + 1 >= 3 THEN NOW() + (${Math.min(300, delaySeconds)} * INTERVAL '1 second') ELSE next_health_probe_at END,
            updated_at = NOW()
          WHERE singleton = TRUE
        `;
      }
      if (!shouldRetry && (job.kind === "direct_message" || job.kind === "follow_check" || job.payload.followGate)) {
        await tx`
          UPDATE follow_gate_sessions SET status = 'failed', last_error = ${message}, updated_at = NOW()
          WHERE event_id = ${job.event_id}
        `;
      }
      if (!shouldRetry && job.kind === "follow_up") {
        await tx`
          UPDATE follow_up_sessions SET status = 'failed', last_error = ${message}, updated_at = NOW()
          WHERE event_id = ${job.event_id}
        `;
      }
    });
    if (!shouldRetry) await finishEvent(sql, job.event_id);
    return globalState || decision.action === "uncertain" ? Math.min(60_000, delaySeconds * 1000) : config.QUEUE_INTERVAL_MS;
  };

  const tick = async () => {
    if (stopped) return;
    let nextDelay = config.QUEUE_INTERVAL_MS;
    let job: Job | undefined;
    let connection: Connection | undefined;
    try {
      if (!await acquireLease()) {
        nextDelay = 2_000;
        return;
      }
      await refreshSurgeMode();
      const rows = await sql<Connection[]>`
        SELECT ig_user_id, token_enc, graph_version, token_expires_at, outbound_paused, rate_limited_until,
          consecutive_rate_limits, consecutive_api_failures, last_meta_usage_percent, health_state,
          next_health_probe_at, subscription_healthy, subscription_last_checked_at, surge_mode
        FROM meta_connection WHERE singleton = TRUE
      `;
      connection = rows[0];
      if (!connection?.ig_user_id || !connection.token_enc || connection.outbound_paused || BLOCKED_STATES.has(connection.health_state)) {
        nextDelay = 2_000;
        return;
      }
      const pauseUntil = connection.rate_limited_until && connection.rate_limited_until.getTime() > Date.now()
        ? connection.rate_limited_until
        : connection.next_health_probe_at && connection.next_health_probe_at.getTime() > Date.now()
          ? connection.next_health_probe_at : null;
      if (pauseUntil) {
        nextDelay = millisecondsUntil(pauseUntil);
        return;
      }

      job = await claimJob(sql, !surgeMode && privateStreak >= 4);
      if (!job) {
        nextDelay = 1_000;
        return;
      }
      if (jobExpired(job)) {
        await sql`UPDATE jobs SET status = 'expired', last_error = 'Delivery eligibility window expired.',
          last_error_action = 'permanent', dispatch_started_at = NULL, updated_at = NOW() WHERE id = ${job.id}`;
        if (job.kind === "direct_message" || job.kind === "follow_check" || job.payload.followGate) {
          await sql`
            UPDATE follow_gate_sessions SET status = 'failed', last_error = 'Messaging response window expired.',
              updated_at = NOW() WHERE event_id = ${job.event_id}
          `;
        }
        if (job.kind === "follow_up") {
          await sql`
            UPDATE follow_up_sessions SET status = 'failed', last_error = 'Messaging response window expired.',
              updated_at = NOW() WHERE event_id = ${job.event_id}
          `;
        }
        await finishEvent(sql, job.event_id);
        return;
      }

      let context: SendContext;
      try {
        context = connectionContext(connection);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to decrypt Meta credentials";
        await sql`
          UPDATE meta_connection SET health_state = 'misconfigured', health_reason = ${message},
            health_since = NOW(), next_health_probe_at = NULL, updated_at = NOW() WHERE singleton = TRUE
        `;
        await sql`UPDATE jobs SET status = 'retry_wait', attempts = GREATEST(attempts - 1, 0),
          next_attempt_at = NOW() + INTERVAL '1 hour', last_error = ${message}, last_error_action = 'pause_auth',
          dispatch_started_at = NULL, updated_at = NOW() WHERE id = ${job.id}`;
        return;
      }

      // Once a public write became ambiguous, every later attempt must reconcile first.
      // A failed reconciliation read may temporarily move the job to retry_wait, so the
      // durable counter is the source of truth rather than only previous_status.
      if (job.ambiguous_attempts > 0 && job.kind === "public_reply") {
        const alreadyExists = await meta.hasPublicReply(context, job.payload.commentId!, job.payload.message!);
        if (alreadyExists) {
          await markSent(job, "reconciled-public-reply");
          return;
        }
      }

      if (job.kind === "follow_up") {
        const followUpJob = job;
        const sessions = await sql<{ status: string; clicked_at: Date | null }[]>`
          SELECT status, clicked_at FROM follow_up_sessions WHERE event_id = ${followUpJob.event_id}
        `;
        const session = sessions[0];
        if (!session || session.clicked_at || session.status !== "scheduled") {
          await sql.begin(async (tx) => {
            await tx`
              UPDATE jobs SET status = 'skipped', external_id = 'follow-up-cancelled',
                dispatch_started_at = NULL, updated_at = NOW() WHERE id = ${followUpJob.id}
            `;
            if (session && session.status === "scheduled") {
              await tx`
                UPDATE follow_up_sessions SET status = 'cancelled', updated_at = NOW()
                WHERE event_id = ${followUpJob.event_id}
              `;
            }
          });
          await finishEvent(sql, followUpJob.event_id);
          return;
        }
      }

      if (job.kind === "follow_check") {
        const follow = await meta.userFollowStatus(context, job.payload.scopedUserId!);
        await completeFollowCheck(job, follow.isUserFollowBusiness, follow.usagePercent);
        privateStreak += 1;
        nextDelay = adaptiveIntervalMs(config.QUEUE_INTERVAL_MS, follow.usagePercent ?? connection.last_meta_usage_percent);
        return;
      }
      const result = job.kind === "public_reply"
        ? await meta.publicReply(context, job.payload.commentId!, job.payload.message!)
        : job.kind === "private_reply"
          ? await meta.privateReply(context, job.payload.commentId!, job.payload.message!, job.payload.button, job.payload.quickReply)
          : await meta.directMessage(context, job.payload.scopedUserId!, job.payload.message!, job.payload.button, job.payload.quickReply);
      await markSent(job, result.externalId, result.usagePercent, result.recipientId);
      privateStreak = job.kind !== "public_reply" ? privateStreak + 1 : 0;
      nextDelay = (result.usagePercent ?? 0) >= 95
        ? 60_000
        : adaptiveIntervalMs(config.QUEUE_INTERVAL_MS, result.usagePercent ?? connection.last_meta_usage_percent);
    } catch (error) {
      if (job && connection) {
        try {
          nextDelay = await handleJobError(job, error, connection);
        } catch {
          // The watchdog recovers the processing row when PostgreSQL becomes available again.
          nextDelay = 5_000;
        }
      } else {
        nextDelay = 5_000;
      }
    } finally {
      timer = setTimeout(tick, nextDelay);
      timer.unref();
    }
  };

  const maintainConnection = async () => {
    if (healthCheckRunning || stopped || !await acquireLease()) return;
    healthCheckRunning = true;
    try {
      const rows = await sql<Connection[]>`
        SELECT ig_user_id, token_enc, graph_version, token_expires_at, outbound_paused, rate_limited_until,
          consecutive_rate_limits, consecutive_api_failures, last_meta_usage_percent, health_state,
          next_health_probe_at, subscription_healthy, subscription_last_checked_at, surge_mode
        FROM meta_connection WHERE singleton = TRUE
      `;
      const connection = rows[0];
      if (!connection?.ig_user_id || !connection.token_enc) return;
      let context: SendContext;
      try {
        context = connectionContext(connection);
      } catch (error) {
        await sql`UPDATE meta_connection SET health_state = 'misconfigured',
          health_reason = ${error instanceof Error ? error.message : "Unable to decrypt Meta credentials"},
          health_since = NOW(), updated_at = NOW() WHERE singleton = TRUE`;
        return;
      }

      if (connection.token_expires_at && connection.token_expires_at.getTime() <= Date.now() + 7 * 86_400_000) {
        try {
          const refreshed = await meta.refreshToken(context);
          context = { ...context, token: refreshed.accessToken };
          await sql`
            UPDATE meta_connection SET token_enc = ${box.seal(refreshed.accessToken)},
              token_expires_at = ${refreshed.expiresIn ? sql`NOW() + (${refreshed.expiresIn} * INTERVAL '1 second')` : connection.token_expires_at},
              token_refresh_error = NULL, token_refresh_failures = 0, updated_at = NOW()
            WHERE singleton = TRUE
          `;
        } catch (error) {
          const decision = retryDecision(error, 1);
          const state = stateForDecision(decision);
          await sql`
            UPDATE meta_connection SET token_refresh_error = ${error instanceof Error ? error.message.slice(0, 1000) : "Token refresh failed"},
              token_refresh_failures = token_refresh_failures + 1,
              health_state = ${state === "reauth_required" ? state : connection.health_state},
              health_reason = ${state === "reauth_required" ? "Instagram authorization must be renewed." : null},
              health_since = CASE WHEN ${state === "reauth_required"} THEN NOW() ELSE health_since END,
              updated_at = NOW() WHERE singleton = TRUE
          `;
          if (state === "reauth_required") return;
        }
      }

      const profile = await meta.profile(context);
      let fields = await meta.subscribedFields(context);
      const requiredFields = ["comments", "messages", "messaging_postbacks"];
      if (requiredFields.some((field) => !fields.includes(field))) {
        await meta.subscribeToWebhooks(context);
        fields = await meta.subscribedFields(context);
      }
      const subscribed = requiredFields.every((field) => fields.includes(field));
      await sql`
        UPDATE meta_connection SET username = ${profile.username ?? null}, subscription_healthy = ${subscribed},
          subscription_last_checked_at = NOW(), last_meta_response_at = NOW(),
          health_state = ${subscribed ? "healthy" : "permission_required"},
          health_reason = ${subscribed ? null : "Instagram messaging webhook subscriptions could not be restored."},
          health_since = NOW(), next_health_probe_at = NULL, consecutive_api_failures = 0, updated_at = NOW()
        WHERE singleton = TRUE
      `;
    } catch (error) {
      const decision = retryDecision(error, 1);
      const state = stateForDecision(decision) ?? "degraded";
      await sql`
        UPDATE meta_connection SET health_state = ${state},
          health_reason = ${error instanceof Error ? error.message.slice(0, 1000) : "Connection health check failed"},
          health_since = NOW(), next_health_probe_at = ${state === "reauth_required" || state === "permission_required" ? null : sql`NOW() + INTERVAL '15 minutes'`},
          subscription_healthy = CASE WHEN ${state === "permission_required"} THEN FALSE ELSE subscription_healthy END,
          updated_at = NOW() WHERE singleton = TRUE
      `;
    } finally {
      healthCheckRunning = false;
    }
  };

  const recoverStaleJobs = async () => {
    await sql`
      UPDATE jobs SET status = CASE WHEN kind = 'follow_check' THEN 'retry_wait' ELSE 'uncertain' END,
        ambiguous_attempts = ambiguous_attempts + CASE WHEN kind = 'follow_check' THEN 0 ELSE 1 END,
        next_attempt_at = NOW() + CASE WHEN kind = 'follow_check' THEN INTERVAL '5 seconds' ELSE INTERVAL '5 minutes' END,
        last_error = 'Worker stopped during delivery; result requires recovery.',
        last_error_code = 'worker_interrupted',
        last_error_action = CASE WHEN kind = 'follow_check' THEN 'retry' ELSE 'uncertain' END,
        dispatch_started_at = NULL, updated_at = NOW()
      WHERE status = 'processing' AND dispatch_started_at < NOW() - (${config.PROCESSING_TIMEOUT_SECONDS} * INTERVAL '1 second')
    `;
  };

  void acquireLease().then(async (leader) => {
    if (!leader) return tick();
    await sql`
      UPDATE jobs SET status = CASE WHEN kind = 'follow_check' THEN 'retry_wait' ELSE 'uncertain' END,
        ambiguous_attempts = ambiguous_attempts + CASE WHEN kind = 'follow_check' THEN 0 ELSE 1 END,
        next_attempt_at = NOW() + CASE WHEN kind = 'follow_check' THEN INTERVAL '5 seconds' ELSE INTERVAL '5 minutes' END,
        last_error = 'Worker restarted during delivery; result requires recovery.',
        last_error_code = 'worker_restarted',
        last_error_action = CASE WHEN kind = 'follow_check' THEN 'retry' ELSE 'uncertain' END,
        dispatch_started_at = NULL, updated_at = NOW()
      WHERE status = 'processing'
    `;
    void maintainConnection().catch(() => undefined);
    return tick();
  }).catch(() => {
    timer = setTimeout(tick, 5_000);
    timer.unref();
  });

  const maintenance = setInterval(() => {
    void Promise.allSettled([
      sql`DELETE FROM events WHERE created_at < NOW() - INTERVAL '30 days'`,
      sql`DELETE FROM oauth_states WHERE expires_at < NOW()`,
      sql`
        WITH expired AS (
          UPDATE jobs SET status = 'expired', last_error = 'Delivery eligibility window expired.',
            last_error_action = 'permanent', dispatch_started_at = NULL, updated_at = NOW()
          WHERE status IN ('queued', 'retry_wait', 'uncertain') AND created_at < NOW() - INTERVAL '7 days'
          RETURNING event_id
        )
        UPDATE events SET status = 'failed', error_message = 'Delivery eligibility window expired.', processed_at = NOW()
        WHERE id IN (SELECT event_id FROM expired)
      `,
      recoverStaleJobs(),
    ]);
  }, 60_000);
  maintenance.unref();

  const healthTimer = setInterval(() => void maintainConnection().catch(() => undefined), 3_600_000);
  healthTimer.unref();

  return async () => {
    stopped = true;
    leaseRenewAfter = 0;
    if (timer) clearTimeout(timer);
    clearInterval(maintenance);
    clearInterval(healthTimer);
    await sql`
      UPDATE worker_leases SET owner_id = NULL, expires_at = NULL, updated_at = NOW()
      WHERE singleton = TRUE AND owner_id = ${ownerId}
    `.catch(() => undefined);
  };
}
