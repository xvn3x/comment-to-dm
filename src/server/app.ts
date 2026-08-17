import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import {
  enqueueComment,
  enqueueInboundMessage,
  extractComments,
  extractInboundMessages,
  extractMessagingActions,
} from "./automation.js";
import { MetaClient } from "./meta.js";
import { retryDecision } from "./rate-control.js";
import { privacyPolicyHtml } from "./privacy.js";
import {
  SecretBox,
  createSession,
  hashPassword,
  verifyMetaSignature,
  verifyMetaSignedRequest,
  verifyPassword,
  verifySession,
} from "./security.js";

declare module "fastify" {
  interface FastifyRequest { rawBody?: string | Buffer }
}

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  priority: z.number().int().min(1).max(10_000).default(100),
  triggerType: z.enum(["comment", "direct_message", "story_reply"]).default("comment"),
  targetScope: z.enum(["all", "specific"]),
  mediaId: z.string().trim().min(1).max(100).nullable().optional(),
  matchMode: z.enum(["any", "contains", "exact"]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  publicReplyEnabled: z.boolean().default(true),
  publicReplies: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  directMessageEnabled: z.boolean().default(true),
  dmText: z.string().trim().max(640).default(""),
  buttonText: z.string().trim().min(1).max(20).nullable().optional(),
  buttonUrl: z.string().url().refine((url) => url.startsWith("https://"), "Only HTTPS links are allowed").nullable().optional(),
  followGateEnabled: z.boolean().default(false),
  followGatePrompt: z.string().trim().min(1).max(640).nullable().optional(),
  followGateButtonText: z.string().trim().min(1).max(20).nullable().optional(),
  followGateRetryText: z.string().trim().min(1).max(640).nullable().optional(),
  followUpEnabled: z.boolean().default(false),
  followUpDelayMinutes: z.number().int().min(1).max(1320).default(60),
  followUpText: z.string().trim().min(1).max(640).nullable().optional(),
}).superRefine((value, context) => {
  const directMessageEnabled = value.triggerType !== "comment" || value.directMessageEnabled;
  if (value.triggerType === "direct_message" && value.targetScope !== "all") {
    context.addIssue({ code: "custom", path: ["targetScope"], message: "Direct message rules apply to all conversations" });
  }
  if (value.targetScope === "specific" && !value.mediaId) {
    context.addIssue({ code: "custom", path: ["mediaId"], message: "Media ID is required" });
  }
  if (value.matchMode !== "any" && !value.keywords.length) {
    context.addIssue({ code: "custom", path: ["keywords"], message: "Add at least one keyword" });
  }
  if (value.triggerType !== "comment" && value.publicReplyEnabled) {
    context.addIssue({ code: "custom", path: ["publicReplyEnabled"], message: "Public replies are available only for comments" });
  }
  if (value.publicReplyEnabled && !value.publicReplies.length) {
    context.addIssue({ code: "custom", path: ["publicReplies"], message: "Add a public reply" });
  }
  if (value.triggerType === "comment" && !value.publicReplyEnabled && !directMessageEnabled) {
    context.addIssue({ code: "custom", path: ["directMessageEnabled"], message: "Enable a comment reply or a Direct message" });
  }
  if (directMessageEnabled && !value.dmText) {
    context.addIssue({ code: "custom", path: ["dmText"], message: "Add a Direct message" });
  }
  if (directMessageEnabled && Boolean(value.buttonText) !== Boolean(value.buttonUrl)) {
    context.addIssue({ code: "custom", path: ["buttonText"], message: "Button text and URL must be provided together" });
  }
  if (Buffer.byteLength(value.dmText, "utf8") > 1000) {
    context.addIssue({ code: "custom", path: ["dmText"], message: "Direct message exceeds 1000 UTF-8 bytes" });
  }
  if (!directMessageEnabled && (value.followGateEnabled || value.followUpEnabled)) {
    context.addIssue({ code: "custom", path: ["directMessageEnabled"], message: "Direct must be enabled for follower checks and follow-ups" });
  }
  if (directMessageEnabled && value.followGateEnabled) {
    if (!value.followGatePrompt) context.addIssue({ code: "custom", path: ["followGatePrompt"], message: "Add the first Direct message" });
    if (!value.followGateButtonText) context.addIssue({ code: "custom", path: ["followGateButtonText"], message: "Add the check button title" });
    if (!value.followGateRetryText) context.addIssue({ code: "custom", path: ["followGateRetryText"], message: "Add the retry message" });
    for (const [path, text] of [["followGatePrompt", value.followGatePrompt], ["followGateRetryText", value.followGateRetryText]] as const) {
      if (text && Buffer.byteLength(text, "utf8") > 1000) context.addIssue({ code: "custom", path: [path], message: "Message exceeds 1000 UTF-8 bytes" });
    }
  }
  if (directMessageEnabled && value.followUpEnabled) {
    if (value.triggerType === "comment" && !value.followGateEnabled) {
      context.addIssue({ code: "custom", path: ["followUpEnabled"], message: "Comment follow-ups require the follower-check postback to open the messaging window" });
    }
    if (!value.buttonText || !value.buttonUrl) {
      context.addIssue({ code: "custom", path: ["buttonUrl"], message: "A material link is required to detect whether the follow-up should be cancelled" });
    }
    if (!value.followUpText) {
      context.addIssue({ code: "custom", path: ["followUpText"], message: "Add the follow-up message" });
    } else if (Buffer.byteLength(value.followUpText, "utf8") > 1000) {
      context.addIssue({ code: "custom", path: ["followUpText"], message: "Follow-up message exceeds 1000 UTF-8 bytes" });
    }
  }
  value.publicReplies.forEach((text, index) => {
    if (Buffer.byteLength(text, "utf8") > 1000) {
      context.addIssue({ code: "custom", path: ["publicReplies", index], message: "Public reply exceeds 1000 UTF-8 bytes" });
    }
  });
});

function toRuleValues(value: z.infer<typeof ruleSchema>) {
  const directMessageEnabled = value.triggerType !== "comment" || value.directMessageEnabled;
  return {
    ...value,
    targetScope: value.triggerType === "direct_message" ? "all" as const : value.targetScope,
    mediaId: value.targetScope === "all" ? null : value.mediaId ?? null,
    publicReplyEnabled: value.triggerType === "comment" ? value.publicReplyEnabled : false,
    publicReplies: value.triggerType === "comment" && value.publicReplyEnabled ? value.publicReplies : [],
    directMessageEnabled,
    dmText: directMessageEnabled ? value.dmText : "",
    buttonText: directMessageEnabled ? value.buttonText || null : null,
    buttonUrl: directMessageEnabled ? value.buttonUrl || null : null,
    followGateEnabled: directMessageEnabled && value.followGateEnabled,
    followGatePrompt: directMessageEnabled && value.followGateEnabled ? value.followGatePrompt || null : null,
    followGateButtonText: directMessageEnabled && value.followGateEnabled ? value.followGateButtonText || null : null,
    followGateRetryText: directMessageEnabled && value.followGateEnabled ? value.followGateRetryText || null : null,
    followUpEnabled: directMessageEnabled && value.followUpEnabled,
    followUpText: directMessageEnabled && value.followUpEnabled ? value.followUpText || null : null,
  };
}

export async function buildApp(sql: Db, config: AppConfig) {
  const app = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
  const box = new SecretBox(config.ENCRYPTION_KEY);
  const meta = new MetaClient(config);
  const passwordHash = hashPassword(config.ADMIN_PASSWORD, Buffer.from(config.SESSION_SECRET.slice(0, 16)));
  const cookieName = "commentdm_session";

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { global: false });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
  app.addHook("onRequest", async (request) => {
    request.log.info({ method: request.method, path: request.url.split("?", 1)[0] }, "incoming request");
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ statusCode: reply.statusCode, responseTime: reply.elapsedTime }, "request completed");
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"))));
  });

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifySession(request.cookies[cookieName], config.SESSION_SECRET)) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin;
      const allowed = new Set([config.PUBLIC_BASE_URL, "http://localhost:5173", "http://127.0.0.1:5173"]);
      if (origin && !allowed.has(origin)) return reply.code(403).send({ error: "invalid_origin" });
    }
  };

  app.get("/health", async (_request, reply) => {
    try {
      await sql`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, database: false });
    }
  });
  app.get("/ready", async (_request, reply) => {
    try {
      const rows = await sql<{ worker_ready: boolean }[]>`
        SELECT COALESCE(worker_heartbeat_at > NOW() - INTERVAL '90 seconds', FALSE) AS worker_ready
        FROM meta_connection WHERE singleton = TRUE
      `;
      const ready = Boolean(rows[0]?.worker_ready);
      return reply.code(ready ? 200 : 503).send({ ok: ready, database: true, worker: ready });
    } catch {
      return reply.code(503).send({ ok: false, database: false, worker: false });
    }
  });
  const sendPrivacyPolicy = async (_request: FastifyRequest, reply: FastifyReply) => reply
    .header("Cache-Control", "public, max-age=3600")
    .type("text/html; charset=utf-8")
    .send(privacyPolicyHtml());
  app.get("/privacy", sendPrivacyPolicy);
  app.get("/privacy/", sendPrivacyPolicy);
  app.get("/r/:token", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const token = z.string().uuid().safeParse((request.params as { token?: unknown }).token);
    if (!token.success) return reply.code(404).send({ error: "link_not_found" });
    const rows = await sql<{ event_id: string; destination_url: string }[]>`
      UPDATE follow_up_sessions SET clicked_at = COALESCE(clicked_at, NOW()),
        status = CASE WHEN status IN ('awaiting_window', 'scheduled') THEN 'cancelled' ELSE status END,
        updated_at = NOW()
      WHERE tracking_token = ${token.data}
      RETURNING event_id, destination_url
    `;
    const link = rows[0];
    if (!link) return reply.code(404).send({ error: "link_not_found" });
    await sql`
      UPDATE jobs SET status = 'skipped', external_id = 'material-opened', dispatch_started_at = NULL, updated_at = NOW()
      WHERE event_id = ${link.event_id} AND kind = 'follow_up'
        AND status IN ('queued', 'retry_wait', 'uncertain')
    `;
    return reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").redirect(link.destination_url);
  });
  app.get("/api/session", async (request) => ({
    authenticated: verifySession(request.cookies[cookieName], config.SESSION_SECRET),
    metaMode: config.META_MODE,
  }));

  app.post("/api/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = z.object({ password: z.string().min(1).max(500) }).safeParse(request.body);
    if (!parsed.success || !verifyPassword(parsed.data.password, passwordHash)) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    reply.setCookie(cookieName, createSession(config.SESSION_SECRET), {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 43_200,
    });
    return { ok: true };
  });

  app.post("/api/logout", { preHandler: requireAuth }, async (_request, reply) => {
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/api/dashboard", { preHandler: requireAuth }, async () => {
    const connectionRows = await sql`
      SELECT app_id, graph_version, ig_user_id, username, token_expires_at, connected_at,
             outbound_paused, rate_limited_until, rate_limit_reason,
             last_meta_usage_percent, last_meta_response_at, health_state, health_reason, health_since,
             next_health_probe_at, token_refresh_error, token_refresh_failures, subscription_healthy,
             subscription_last_checked_at, worker_heartbeat_at, last_webhook_at, last_webhook_error,
             unparsed_webhooks, surge_mode
      FROM meta_connection WHERE singleton = TRUE
    `;
    const rules = await sql`SELECT * FROM rules ORDER BY priority ASC, created_at DESC`;
    const events = await sql`
      SELECT e.id, e.comment_id, e.media_id, e.username, e.trigger_type, e.status, e.error_message, e.created_at, e.processed_at,
             r.name AS rule_name
      FROM events e LEFT JOIN rules r ON r.id = e.rule_id
      ORDER BY e.created_at DESC LIMIT 100
    `;
    const stats = await sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS total_24h,
        COUNT(*) FILTER (WHERE status = 'sent' AND created_at >= NOW() - INTERVAL '24 hours')::int AS sent_24h,
        COUNT(*) FILTER (WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours')::int AS failed_24h
      FROM events
    `;
    const queue = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued', 'processing', 'retry_wait', 'uncertain'))::int AS pending,
        COUNT(*) FILTER (WHERE kind IN ('private_reply', 'direct_message', 'follow_check', 'follow_up') AND status IN ('queued', 'processing', 'retry_wait', 'uncertain'))::int AS private_pending,
        COUNT(*) FILTER (WHERE kind = 'public_reply' AND status IN ('queued', 'processing', 'retry_wait', 'uncertain'))::int AS public_pending,
        COUNT(*) FILTER (WHERE status = 'retry_wait')::int AS retrying,
        COUNT(*) FILTER (WHERE status = 'uncertain')::int AS uncertain,
        COUNT(*) FILTER (WHERE status IN ('failed', 'dead_letter'))::int AS failed,
        COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status IN ('queued', 'processing', 'retry_wait', 'uncertain'))))::int, 0) AS oldest_seconds,
        (COUNT(*) FILTER (WHERE status = 'sent' AND updated_at >= NOW() - INTERVAL '5 minutes')::float / 5)::float AS throughput_per_minute
      FROM jobs
    `;
    return {
      connection: connectionRows[0],
      rules,
      events,
      stats: stats[0],
      queue: queue[0],
      urls: {
        oauthCallback: `${config.PUBLIC_BASE_URL}/api/meta/oauth/callback`,
        webhook: `${config.PUBLIC_BASE_URL}/webhooks/instagram`,
        deauthorize: `${config.PUBLIC_BASE_URL}/api/meta/deauthorize`,
        dataDeletion: `${config.PUBLIC_BASE_URL}/api/meta/data-deletion`,
      },
      metaMode: config.META_MODE,
    };
  });

  app.post("/api/queue/pause", { preHandler: requireAuth }, async () => {
    await sql`UPDATE meta_connection SET outbound_paused = TRUE, updated_at = NOW() WHERE singleton = TRUE`;
    return { ok: true };
  });

  app.post("/api/queue/resume", { preHandler: requireAuth }, async () => {
    await sql`UPDATE meta_connection SET outbound_paused = FALSE, updated_at = NOW() WHERE singleton = TRUE`;
    return { ok: true };
  });

  app.post("/api/queue/retry-failed", { preHandler: requireAuth }, async () => {
    const rows = await sql<{ count: number }[]>`
      WITH retried AS (
        UPDATE jobs SET status = 'retry_wait', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE status IN ('failed', 'dead_letter')
          AND (kind <> 'private_reply' OR created_at >= NOW() - INTERVAL '7 days')
        RETURNING event_id
      ), updated_events AS (
        UPDATE events SET status = 'queued', error_message = NULL, processed_at = NULL
        WHERE id IN (SELECT event_id FROM retried)
      )
      SELECT COUNT(*)::int AS count FROM retried
    `;
    return { ok: true, count: rows[0]?.count ?? 0 };
  });

  app.post("/api/meta/config", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({
      appId: z.string().trim().min(5).max(100),
      appSecret: z.string().trim().min(8).max(500),
      graphVersion: z.string().regex(/^v\d+\.\d+$/).default(config.META_GRAPH_VERSION),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", details: parsed.error.flatten() });
    await sql`
      UPDATE meta_connection SET
        app_id = ${parsed.data.appId}, app_secret_enc = ${box.seal(parsed.data.appSecret)},
        graph_version = ${parsed.data.graphVersion}, ig_user_id = NULL, username = NULL,
        token_enc = NULL, token_expires_at = NULL, connected_at = NULL,
        health_state = 'healthy', health_reason = NULL, subscription_healthy = NULL, updated_at = NOW()
      WHERE singleton = TRUE
    `;
    return { ok: true };
  });

  app.get("/api/meta/oauth-url", { preHandler: requireAuth }, async (_request, reply) => {
    const rows = await sql<{ app_id: string | null; app_secret_enc: string | null; graph_version: string }[]>`
      SELECT app_id, app_secret_enc, graph_version FROM meta_connection WHERE singleton = TRUE
    `;
    const connection = rows[0];
    if (!connection?.app_id || !connection.app_secret_enc) return reply.code(409).send({ error: "meta_not_configured" });
    const state = randomBytes(32).toString("base64url");
    await sql`INSERT INTO oauth_states (state, expires_at) VALUES (${state}, NOW() + INTERVAL '10 minutes')`;
    const redirectUri = `${config.PUBLIC_BASE_URL}/api/meta/oauth/callback`;
    const url = config.META_MODE === "mock"
      ? `${redirectUri}?code=mock&state=${encodeURIComponent(state)}`
      : meta.authorizationUrl({
          appId: connection.app_id,
          appSecret: box.open(connection.app_secret_enc),
          graphVersion: connection.graph_version,
        }, state, redirectUri);
    return { url };
  });

  app.get("/api/meta/oauth/callback", async (request, reply) => {
    const parsed = z.object({ code: z.string().min(1), state: z.string().min(10) }).safeParse(request.query);
    if (!parsed.success) return reply.redirect("/?error=oauth_invalid_callback");
    const states = await sql<{ state: string }[]>`
      DELETE FROM oauth_states WHERE state = ${parsed.data.state} AND expires_at > NOW() RETURNING state
    `;
    if (!states.length) return reply.redirect("/?error=oauth_state_expired");
    const rows = await sql<{ app_id: string | null; app_secret_enc: string | null; graph_version: string }[]>`
      SELECT app_id, app_secret_enc, graph_version FROM meta_connection WHERE singleton = TRUE
    `;
    const connection = rows[0];
    if (!connection?.app_id || !connection.app_secret_enc) return reply.redirect("/?error=meta_not_configured");
    try {
      const credentials = {
        appId: connection.app_id,
        appSecret: box.open(connection.app_secret_enc),
        graphVersion: connection.graph_version,
      };
      const token = await meta.exchangeCode(credentials, parsed.data.code, `${config.PUBLIC_BASE_URL}/api/meta/oauth/callback`);
      const oauthContext = { igUserId: token.userId, token: token.accessToken, graphVersion: credentials.graphVersion };
      const profile = await meta.profile(oauthContext);
      // The OAuth exchange returns an app-scoped user ID. Instagram's
      // subscribed_apps edge expects the professional account ID returned by
      // /me as user_id, so use the resolved profile ID from this point on.
      const context = { ...oauthContext, igUserId: profile.id };
      await meta.subscribeToWebhooks(context);
      await sql`
        UPDATE meta_connection SET ig_user_id = ${profile.id}, username = ${profile.username ?? null},
          token_enc = ${box.seal(token.accessToken)},
          token_expires_at = ${token.expiresIn ? sql`NOW() + (${token.expiresIn} * INTERVAL '1 second')` : null},
          connected_at = NOW(), health_state = 'healthy', health_reason = NULL, health_since = NOW(),
          next_health_probe_at = NULL, token_refresh_error = NULL, token_refresh_failures = 0,
          subscription_healthy = TRUE, subscription_last_checked_at = NOW(),
          rate_limited_until = NULL, rate_limit_reason = NULL, consecutive_api_failures = 0, updated_at = NOW()
        WHERE singleton = TRUE
      `;
      return reply.redirect("/?connected=1");
    } catch (error) {
      request.log.error(error);
      return reply.redirect(`/?error=${encodeURIComponent(error instanceof Error ? error.message : "oauth_failed")}`);
    }
  });

  app.delete("/api/meta/connection", { preHandler: requireAuth }, async () => {
    await sql`
      UPDATE meta_connection SET ig_user_id = NULL, username = NULL, token_enc = NULL,
        token_expires_at = NULL, connected_at = NULL, health_state = 'healthy', health_reason = NULL,
        subscription_healthy = NULL, updated_at = NOW()
      WHERE singleton = TRUE
    `;
    return { ok: true };
  });

  app.post("/api/meta/health-check", { preHandler: requireAuth }, async (_request, reply) => {
    const rows = await sql<{ ig_user_id: string | null; token_enc: string | null; graph_version: string }[]>`
      SELECT ig_user_id, token_enc, graph_version FROM meta_connection WHERE singleton = TRUE
    `;
    const connection = rows[0];
    if (!connection?.ig_user_id || !connection.token_enc) return reply.code(409).send({ error: "instagram_not_connected" });
    try {
      const context = { igUserId: connection.ig_user_id, token: box.open(connection.token_enc), graphVersion: connection.graph_version };
      const profile = await meta.profile(context);
      let fields = await meta.subscribedFields(context);
      const requiredFields = ["comments", "messages", "messaging_postbacks"];
      if (requiredFields.some((field) => !fields.includes(field))) {
        await meta.subscribeToWebhooks(context);
        fields = await meta.subscribedFields(context);
      }
      if (requiredFields.some((field) => !fields.includes(field))) throw new Error("Instagram webhook subscriptions are missing");
      await sql`
        UPDATE meta_connection SET username = ${profile.username ?? null}, health_state = 'healthy',
          health_reason = NULL, health_since = NOW(), next_health_probe_at = NULL,
          subscription_healthy = TRUE, subscription_last_checked_at = NOW(),
          consecutive_api_failures = 0, rate_limited_until = NULL, rate_limit_reason = NULL, updated_at = NOW()
        WHERE singleton = TRUE
      `;
      return { ok: true, username: profile.username, subscribedFields: fields };
    } catch (error) {
      const decision = retryDecision(error, 1);
      const state = decision.action === "pause_auth" ? "reauth_required"
        : decision.action === "pause_permission" ? "permission_required"
          : decision.action === "pause_restricted" ? "restricted" : "degraded";
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Connection check failed";
      await sql`
        UPDATE meta_connection SET health_state = ${state}, health_reason = ${message}, health_since = NOW(),
          subscription_healthy = CASE WHEN ${state === "permission_required"} THEN FALSE ELSE subscription_healthy END,
          updated_at = NOW() WHERE singleton = TRUE
      `;
      return reply.code(409).send({ error: "meta_health_check_failed", state, message });
    }
  });

  app.post("/api/meta/follow-status", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ eventId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_event" });
    const events = await sql<{ sender_id: string; username: string | null }[]>`
      SELECT sender_id, username FROM events WHERE id = ${parsed.data.eventId}
    `;
    if (!events[0]) return reply.code(404).send({ error: "event_not_found" });
    const connections = await sql<{ ig_user_id: string | null; token_enc: string | null; graph_version: string }[]>`
      SELECT ig_user_id, token_enc, graph_version FROM meta_connection WHERE singleton = TRUE
    `;
    const connection = connections[0];
    if (!connection?.ig_user_id || !connection.token_enc) {
      return reply.code(409).send({ error: "instagram_not_connected" });
    }
    try {
      const status = await meta.userFollowStatus({
        igUserId: connection.ig_user_id,
        token: box.open(connection.token_enc),
        graphVersion: connection.graph_version,
      }, events[0].sender_id);
      return {
        available: true,
        username: status.username ?? events[0].username,
        isUserFollowBusiness: status.isUserFollowBusiness,
        isBusinessFollowUser: status.isBusinessFollowUser,
      };
    } catch (error) {
      request.log.info({ err: error, eventId: parsed.data.eventId }, "Follower status diagnostic was unavailable");
      return {
        available: false,
        username: events[0].username,
        reason: error instanceof Error ? error.message.slice(0, 500) : "Meta profile lookup failed",
      };
    }
  });

  app.get("/api/meta/media", { preHandler: requireAuth }, async (_request, reply) => {
    const rows = await sql<{ ig_user_id: string | null; token_enc: string | null; graph_version: string }[]>`
      SELECT ig_user_id, token_enc, graph_version FROM meta_connection WHERE singleton = TRUE
    `;
    const connection = rows[0];
    if (!connection?.ig_user_id || !connection.token_enc) return reply.code(409).send({ error: "instagram_not_connected" });
    return meta.listMedia({
      igUserId: connection.ig_user_id,
      token: box.open(connection.token_enc),
      graphVersion: connection.graph_version,
    });
  });

  app.get("/api/rules", { preHandler: requireAuth }, async () =>
    sql`SELECT * FROM rules ORDER BY priority ASC, created_at DESC`
  );

  app.post("/api/rules", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_rule", details: parsed.error.flatten() });
    const value = toRuleValues(parsed.data);
    const rows = await sql`
      INSERT INTO rules (
        id, name, active, priority, trigger_type, target_scope, media_id, match_mode, keywords,
        public_reply_enabled, public_replies, direct_message_enabled, dm_text, button_text, button_url,
        follow_gate_enabled, follow_gate_prompt, follow_gate_button_text, follow_gate_retry_text,
        follow_up_enabled, follow_up_delay_minutes, follow_up_text
      ) VALUES (
        ${randomUUID()}, ${value.name}, ${value.active}, ${value.priority}, ${value.triggerType}, ${value.targetScope}, ${value.mediaId},
        ${value.matchMode}, ${sql.json(value.keywords)}, ${value.publicReplyEnabled}, ${sql.json(value.publicReplies)},
        ${value.directMessageEnabled}, ${value.dmText}, ${value.buttonText}, ${value.buttonUrl}, ${value.followGateEnabled},
        ${value.followGatePrompt}, ${value.followGateButtonText}, ${value.followGateRetryText},
        ${value.followUpEnabled}, ${value.followUpDelayMinutes}, ${value.followUpText}
      ) RETURNING *
    `;
    return reply.code(201).send(rows[0]);
  });

  app.put("/api/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id);
    const parsed = ruleSchema.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_rule" });
    const value = toRuleValues(parsed.data);
    const rows = await sql`
      UPDATE rules SET name = ${value.name}, active = ${value.active}, priority = ${value.priority},
        trigger_type = ${value.triggerType},
        target_scope = ${value.targetScope}, media_id = ${value.mediaId}, match_mode = ${value.matchMode},
        keywords = ${sql.json(value.keywords)}, public_reply_enabled = ${value.publicReplyEnabled},
        public_replies = ${sql.json(value.publicReplies)}, direct_message_enabled = ${value.directMessageEnabled},
        dm_text = ${value.dmText},
        button_text = ${value.buttonText}, button_url = ${value.buttonUrl},
        follow_gate_enabled = ${value.followGateEnabled}, follow_gate_prompt = ${value.followGatePrompt},
        follow_gate_button_text = ${value.followGateButtonText}, follow_gate_retry_text = ${value.followGateRetryText},
        follow_up_enabled = ${value.followUpEnabled}, follow_up_delay_minutes = ${value.followUpDelayMinutes},
        follow_up_text = ${value.followUpText},
        updated_at = NOW()
      WHERE id = ${id.data} RETURNING *
    `;
    return rows[0] ?? reply.code(404).send({ error: "rule_not_found" });
  });

  app.delete("/api/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    await sql`DELETE FROM rules WHERE id = ${id.data}`;
    return { ok: true };
  });

  app.post("/api/mock/comment", { preHandler: requireAuth }, async (request, reply) => {
    if (config.META_MODE !== "mock") return reply.code(404).send({ error: "not_found" });
    const parsed = z.object({
      text: z.string().min(1).max(500),
      mediaId: z.string().min(1).default("demo-reel-1"),
      username: z.string().min(1).default("demo_follower"),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const result = await enqueueComment(sql, {
      commentId: `mock-comment-${randomUUID()}`,
      mediaId: parsed.data.mediaId,
      senderId: `mock-user-${parsed.data.username}`,
      username: parsed.data.username,
      text: parsed.data.text,
    }, { publicBaseUrl: config.PUBLIC_BASE_URL });
    return { result };
  });

  app.post("/api/mock/message", { preHandler: requireAuth }, async (request, reply) => {
    if (config.META_MODE !== "mock") return reply.code(404).send({ error: "not_found" });
    const parsed = z.object({
      text: z.string().max(1000).default(""),
      kind: z.enum(["direct_message", "story_reply"]),
      senderId: z.string().min(1).default(`mock-inbound-${randomUUID()}`),
      storyId: z.string().min(1).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const result = await enqueueInboundMessage(sql, {
      messageId: `mock-message-${randomUUID()}`,
      senderId: parsed.data.senderId,
      text: parsed.data.text,
      kind: parsed.data.kind,
      storyId: parsed.data.kind === "story_reply" ? parsed.data.storyId ?? "mock-story" : undefined,
    }, { publicBaseUrl: config.PUBLIC_BASE_URL });
    return { result };
  });

  app.get("/webhooks/instagram", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === config.META_WEBHOOK_VERIFY_TOKEN) {
      return reply.type("text/plain").send(query["hub.challenge"] ?? "");
    }
    return reply.code(403).send("Forbidden");
  });

  app.post("/webhooks/instagram", { config: { rawBody: true } }, async (request, reply) => {
    if (config.META_MODE === "live") {
      const rows = await sql<{ app_secret_enc: string | null; ig_user_id: string | null }[]>`
        SELECT app_secret_enc, ig_user_id FROM meta_connection WHERE singleton = TRUE
      `;
      if (!rows[0]?.app_secret_enc) return reply.code(503).send({ error: "meta_not_configured" });
      const valid = verifyMetaSignature(
        Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.from(request.rawBody ?? ""),
        request.headers["x-hub-signature-256"] as string | undefined,
        box.open(rows[0].app_secret_enc),
      );
      if (!valid) return reply.code(401).send({ error: "invalid_signature" });
    }
    const connectionRows = await sql<{ ig_user_id: string | null }[]>`
      SELECT ig_user_id FROM meta_connection WHERE singleton = TRUE
    `;
    const connectedId = connectionRows[0]?.ig_user_id;
    const comments = extractComments(request.body).map((comment) => ({
      ...comment,
      isSelf: comment.isSelf || Boolean(connectedId && comment.senderId === connectedId),
    }));
    const inboundMessages = extractInboundMessages(request.body).map((message) => ({
      ...message,
      isSelf: message.isSelf || Boolean(connectedId && message.senderId === connectedId),
    }));
    const messagingActions = extractMessagingActions(request.body)
      .filter((action) => !action.isSelf && (!connectedId || action.senderId !== connectedId) && action.payload.startsWith("follow_gate:"));
    const hasInstagramEntries = Boolean(request.body && typeof request.body === "object"
      && Array.isArray((request.body as { entry?: unknown }).entry)
      && (request.body as { entry: unknown[] }).entry.length);
    await sql`
      UPDATE meta_connection SET last_webhook_at = NOW(),
        last_webhook_error = ${hasInstagramEntries && comments.length === 0 && inboundMessages.length === 0 && messagingActions.length === 0 ? "Instagram webhook contained no recognized events." : null},
        unparsed_webhooks = unparsed_webhooks + ${hasInstagramEntries && comments.length === 0 && inboundMessages.length === 0 && messagingActions.length === 0 ? 1 : 0}, updated_at = NOW()
      WHERE singleton = TRUE
    `;
    for (let index = 0; index < comments.length; index += 20) {
      await Promise.all(comments.slice(index, index + 20)
        .map((comment) => enqueueComment(sql, comment, { publicBaseUrl: config.PUBLIC_BASE_URL })));
    }
    for (let index = 0; index < inboundMessages.length; index += 20) {
      await Promise.all(inboundMessages.slice(index, index + 20)
        .map((message) => enqueueInboundMessage(sql, message, { publicBaseUrl: config.PUBLIC_BASE_URL })));
    }
    for (const action of messagingActions) {
      const eventId = action.payload.slice("follow_gate:".length);
      if (!z.string().uuid().safeParse(eventId).success) continue;
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${eventId}, 2))`;
        const sessions = await tx<{
          event_id: string; scoped_user_id: string | null; status: string; sender_id: string;
        }[]>`
          SELECT s.event_id, s.scoped_user_id, s.status, e.sender_id
          FROM follow_gate_sessions s JOIN events e ON e.id = s.event_id
          WHERE s.event_id = ${eventId} FOR UPDATE OF s
        `;
        const session = sessions[0];
        if (!session || session.status === "delivered") return;
        const expectedSender = session.scoped_user_id ?? session.sender_id;
        if (expectedSender !== action.senderId) {
          request.log.warn({ eventId }, "Ignored follow gate action from another user");
          return;
        }
        const active = await tx<{ present: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM jobs WHERE event_id = ${eventId}
              AND kind IN ('follow_check', 'direct_message')
              AND status IN ('queued', 'processing', 'retry_wait', 'uncertain')
          ) AS present
        `;
        if (active[0]?.present) return;
        const inserted = await tx`
          INSERT INTO jobs (id, event_id, kind, interaction_id, payload)
          VALUES (
            ${randomUUID()}, ${eventId}, 'follow_check', ${action.interactionId},
            ${tx.json({
              scopedUserId: action.senderId,
              expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
            })}
          )
          ON CONFLICT DO NOTHING RETURNING id
        `;
        if (!inserted.length) return;
        await tx`
          UPDATE follow_gate_sessions SET scoped_user_id = COALESCE(scoped_user_id, ${action.senderId}),
            last_error = NULL, updated_at = NOW()
          WHERE event_id = ${eventId}
        `;
        await tx`UPDATE events SET status = 'queued', processed_at = NULL, error_message = NULL WHERE id = ${eventId}`;
      });
    }
    return { received: true };
  });

  const verifySignedCallback = async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = await sql<{ app_secret_enc: string | null }[]>`
      SELECT app_secret_enc FROM meta_connection WHERE singleton = TRUE
    `;
    const value = (request.body as { signed_request?: string } | undefined)?.signed_request;
    if (!rows[0]?.app_secret_enc || !verifyMetaSignedRequest(value, box.open(rows[0].app_secret_enc))) {
      return reply.code(401).send({ error: "invalid_signed_request" });
    }
  };

  app.post("/api/meta/deauthorize", { preHandler: verifySignedCallback }, async () => {
    await sql`
      UPDATE meta_connection SET ig_user_id = NULL, username = NULL, token_enc = NULL,
        token_expires_at = NULL, connected_at = NULL, health_state = 'reauth_required',
        health_reason = 'Instagram deauthorized the application.', health_since = NOW(), updated_at = NOW() WHERE singleton = TRUE
    `;
    return { ok: true };
  });

  app.post("/api/meta/data-deletion", { preHandler: verifySignedCallback }, async () => {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM jobs`;
      await tx`DELETE FROM events`;
      await tx`DELETE FROM rules`;
      await tx`
        UPDATE meta_connection SET ig_user_id = NULL, username = NULL, token_enc = NULL,
          token_expires_at = NULL, connected_at = NULL, updated_at = NOW() WHERE singleton = TRUE
      `;
    });
    return { url: `${config.PUBLIC_BASE_URL}/`, confirmation_code: randomUUID() };
  });

  const clientRoot = join(process.cwd(), "dist", "client");
  if (existsSync(clientRoot)) {
    await app.register(staticPlugin, { root: clientRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/webhooks/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, meta, box };
}
