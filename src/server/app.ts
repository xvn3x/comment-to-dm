import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { enqueueComment, extractComments } from "./automation.js";
import { MetaClient } from "./meta.js";
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
  targetScope: z.enum(["all", "specific"]),
  mediaId: z.string().trim().min(1).max(100).nullable().optional(),
  matchMode: z.enum(["any", "contains", "exact"]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  publicReplyEnabled: z.boolean().default(true),
  publicReplies: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
  dmText: z.string().trim().min(1).max(640),
  buttonText: z.string().trim().min(1).max(20).nullable().optional(),
  buttonUrl: z.string().url().refine((url) => url.startsWith("https://"), "Only HTTPS links are allowed").nullable().optional(),
}).superRefine((value, context) => {
  if (value.targetScope === "specific" && !value.mediaId) {
    context.addIssue({ code: "custom", path: ["mediaId"], message: "Media ID is required" });
  }
  if (value.matchMode !== "any" && !value.keywords.length) {
    context.addIssue({ code: "custom", path: ["keywords"], message: "Add at least one keyword" });
  }
  if (value.publicReplyEnabled && !value.publicReplies.length) {
    context.addIssue({ code: "custom", path: ["publicReplies"], message: "Add a public reply" });
  }
  if (Boolean(value.buttonText) !== Boolean(value.buttonUrl)) {
    context.addIssue({ code: "custom", path: ["buttonText"], message: "Button text and URL must be provided together" });
  }
});

function toRuleValues(value: z.infer<typeof ruleSchema>) {
  return {
    ...value,
    mediaId: value.targetScope === "all" ? null : value.mediaId ?? null,
    publicReplies: value.publicReplyEnabled ? value.publicReplies : [],
    buttonText: value.buttonText || null,
    buttonUrl: value.buttonUrl || null,
  };
}

export async function buildApp(sql: Db, config: AppConfig) {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1_048_576 });
  const box = new SecretBox(config.ENCRYPTION_KEY);
  const meta = new MetaClient(config);
  const passwordHash = hashPassword(config.ADMIN_PASSWORD, Buffer.from(config.SESSION_SECRET.slice(0, 16)));
  const cookieName = "commentdm_session";

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: false });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
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

  app.get("/health", async () => ({ ok: true }));
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
      SELECT app_id, graph_version, ig_user_id, username, token_expires_at, connected_at
      FROM meta_connection WHERE singleton = TRUE
    `;
    const rules = await sql`SELECT * FROM rules ORDER BY priority ASC, created_at DESC`;
    const events = await sql`
      SELECT e.id, e.comment_id, e.media_id, e.username, e.status, e.error_message, e.created_at, e.processed_at,
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
    return {
      connection: connectionRows[0],
      rules,
      events,
      stats: stats[0],
      urls: {
        oauthCallback: `${config.PUBLIC_BASE_URL}/api/meta/oauth/callback`,
        webhook: `${config.PUBLIC_BASE_URL}/webhooks/instagram`,
        deauthorize: `${config.PUBLIC_BASE_URL}/api/meta/deauthorize`,
        dataDeletion: `${config.PUBLIC_BASE_URL}/api/meta/data-deletion`,
      },
      metaMode: config.META_MODE,
    };
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
        token_enc = NULL, token_expires_at = NULL, connected_at = NULL, updated_at = NOW()
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
      await meta.subscribeToComments(context);
      await sql`
        UPDATE meta_connection SET ig_user_id = ${profile.id}, username = ${profile.username ?? null},
          token_enc = ${box.seal(token.accessToken)},
          token_expires_at = ${token.expiresIn ? sql`NOW() + (${token.expiresIn} * INTERVAL '1 second')` : null},
          connected_at = NOW(), updated_at = NOW()
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
        token_expires_at = NULL, connected_at = NULL, updated_at = NOW()
      WHERE singleton = TRUE
    `;
    return { ok: true };
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
        id, name, active, priority, target_scope, media_id, match_mode, keywords,
        public_reply_enabled, public_replies, dm_text, button_text, button_url
      ) VALUES (
        ${randomUUID()}, ${value.name}, ${value.active}, ${value.priority}, ${value.targetScope}, ${value.mediaId},
        ${value.matchMode}, ${sql.json(value.keywords)}, ${value.publicReplyEnabled}, ${sql.json(value.publicReplies)},
        ${value.dmText}, ${value.buttonText}, ${value.buttonUrl}
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
        target_scope = ${value.targetScope}, media_id = ${value.mediaId}, match_mode = ${value.matchMode},
        keywords = ${sql.json(value.keywords)}, public_reply_enabled = ${value.publicReplyEnabled},
        public_replies = ${sql.json(value.publicReplies)}, dm_text = ${value.dmText},
        button_text = ${value.buttonText}, button_url = ${value.buttonUrl}, updated_at = NOW()
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
    });
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
      const rows = await sql<{ app_secret_enc: string | null }[]>`
        SELECT app_secret_enc FROM meta_connection WHERE singleton = TRUE
      `;
      if (!rows[0]?.app_secret_enc) return reply.code(503).send({ error: "meta_not_configured" });
      const valid = verifyMetaSignature(
        Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.from(request.rawBody ?? ""),
        request.headers["x-hub-signature-256"] as string | undefined,
        box.open(rows[0].app_secret_enc),
      );
      if (!valid) return reply.code(401).send({ error: "invalid_signature" });
    }
    const comments = extractComments(request.body);
    await Promise.all(comments.map((comment) => enqueueComment(sql, comment)));
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
        token_expires_at = NULL, connected_at = NULL, updated_at = NOW() WHERE singleton = TRUE
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
