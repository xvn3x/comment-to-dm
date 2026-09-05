import type { AppConfig } from "./config.js";

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly transient = false,
    readonly retryAfterSeconds?: number,
    readonly usagePercent?: number,
    readonly estimatedRecoverySeconds?: number,
  ) {
    super(message);
  }
}

export class MetaTransportError extends Error {
  constructor(message: string, readonly ambiguous: boolean, readonly transportCode?: string) {
    super(message);
  }
}

export class MetaAmbiguousError extends Error {
  readonly ambiguous = true;
}

type MetaCredentials = {
  appId: string;
  appSecret: string;
  graphVersion: string;
};

export type SendContext = {
  igUserId: string;
  token: string;
  graphVersion: string;
};

type RequestMode = "read" | "write";

export type RecoveryPage = {
  data: Array<Record<string, unknown>>;
  after?: string;
  usagePercent?: number;
};

function recoveryPage(body: Record<string, unknown>): RecoveryPage {
  if (!Array.isArray(body.data)) throw new MetaApiError("Malformed recovery page.", 502);
  const paging = body.paging as { next?: unknown; cursors?: { after?: unknown } } | undefined;
  const after = paging?.next ? paging.cursors?.after : undefined;
  if (paging?.next && (typeof after !== "string" || !after || after.length > 4096)) {
    throw new MetaApiError("Missing recovery pagination cursor.", 502);
  }
  if (body.data.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new MetaApiError("Malformed recovery page item.", 502);
  }
  return { data: body.data, after: typeof after === "string" ? after : undefined,
    usagePercent: positiveNumber(body.__usagePercent) };
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function usageFromHeaders(headers: Headers): { percent?: number; recoverySeconds?: number } {
  const percentages: number[] = [];
  const recoveries: number[] = [];
  for (const name of ["x-app-usage", "x-business-use-case-usage"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      const visit = (value: unknown, key?: string) => {
        if (typeof value === "number" && ["call_count", "call_volume", "cpu_time", "total_cputime", "total_time"].includes(key ?? "")) {
          percentages.push(value);
        } else if (typeof value === "number" && key === "estimated_time_to_regain_access") {
          recoveries.push(value);
        } else if (Array.isArray(value)) {
          value.forEach((entry) => visit(entry));
        } else if (value && typeof value === "object") {
          Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
        }
      };
      visit(JSON.parse(raw));
    } catch {
      // Meta may add fields without notice; unknown headers must not break delivery.
    }
  }
  return {
    percent: percentages.length ? Math.max(...percentages) : undefined,
    recoverySeconds: recoveries.length ? Math.max(...recoveries) : undefined,
  };
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = positiveNumber(raw);
  if (seconds) return Math.ceil(seconds);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function transportCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof direct === "string" ? direct : typeof cause === "string" ? cause : undefined;
}

const DEFINITELY_NOT_SENT = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_DNS_TIMEOUT",
]);

async function parseResponse(response: Response, mode: RequestMode): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object expected");
      body = parsed as Record<string, unknown>;
    } catch {
      if (response.ok && mode === "write") throw new MetaAmbiguousError("Meta returned an unreadable success response.");
      throw new MetaApiError("Meta returned an unreadable response.", response.ok ? 502 : response.status, undefined, undefined, true);
    }
  }

  const usage = usageFromHeaders(response.headers);
  if (!response.ok) {
    const detail = (body.error ?? {}) as Record<string, unknown>;
    const errorData = (detail.error_data ?? {}) as Record<string, unknown>;
    throw new MetaApiError(
      String(detail.message ?? `Meta API returned HTTP ${response.status}`),
      response.status,
      typeof detail.code === "number" ? detail.code : undefined,
      typeof detail.error_subcode === "number" ? detail.error_subcode : undefined,
      Boolean(detail.is_transient),
      retryAfterSeconds(response.headers),
      usage.percent,
      positiveNumber(errorData.estimated_time_to_regain_access) ?? usage.recoverySeconds,
    );
  }
  body.__usagePercent = usage.percent;
  return body;
}

function sentResult(body: Record<string, unknown>, idField: "id" | "message_id") {
  const externalId = typeof body[idField] === "string" || typeof body[idField] === "number"
    ? String(body[idField])
    : "";
  if (!externalId) throw new MetaAmbiguousError(`Meta returned success without ${idField}.`);
  return {
    externalId,
    usagePercent: positiveNumber(body.__usagePercent),
    recipientId: body.recipient_id ? String(body.recipient_id) : undefined,
  };
}

export class MetaClient {
  constructor(private readonly config: AppConfig) {}

  private async request(url: string | URL, init: RequestInit = {}, mode: RequestMode = "read") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.META_REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return await parseResponse(response, mode);
    } catch (error) {
      if (error instanceof MetaApiError || error instanceof MetaAmbiguousError) throw error;
      const code = transportCode(error);
      const ambiguous = mode === "write" && !DEFINITELY_NOT_SENT.has(code ?? "");
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new MetaTransportError(`Meta network error${code ? ` (${code})` : ""}: ${message}`, ambiguous, code);
    } finally {
      clearTimeout(timeout);
    }
  }

  authorizationUrl(credentials: MetaCredentials, state: string, redirectUri: string): string {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", credentials.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
    ].join(","));
    url.searchParams.set("state", state);
    url.searchParams.set("force_authentication", "1");
    url.searchParams.set("enable_fb_login", "0");
    return url.toString();
  }

  async exchangeCode(credentials: MetaCredentials, code: string, redirectUri: string) {
    if (this.config.META_MODE === "mock") {
      return { accessToken: "mock-access-token", userId: "17841400000000000", expiresIn: 5_184_000 };
    }
    const form = new URLSearchParams({
      client_id: credentials.appId,
      client_secret: credentials.appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    const short = await this.request("https://api.instagram.com/oauth/access_token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
    }, "write");
    const shortToken = String(short.access_token ?? "");
    const userId = String(short.user_id ?? "");
    if (!shortToken || !userId) throw new MetaApiError("Instagram did not return an access token.", 502, undefined, undefined, true);

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", credentials.appSecret);
    longUrl.searchParams.set("access_token", shortToken);
    const long = await this.request(longUrl);
    return {
      accessToken: String(long.access_token ?? shortToken),
      userId,
      expiresIn: Number(long.expires_in ?? 0) || undefined,
    };
  }

  async profile(context: SendContext): Promise<{ id: string; username?: string }> {
    if (this.config.META_MODE === "mock") return { id: context.igUserId, username: "demo_account" };
    const url = new URL(`https://graph.instagram.com/${context.graphVersion}/me`);
    url.searchParams.set("fields", "id,user_id,username");
    const body = await this.request(url, { headers: { Authorization: `Bearer ${context.token}` } });
    const id = String(body.user_id ?? body.id ?? "");
    if (!id) throw new MetaApiError("Instagram profile response did not include an account ID.", 502, undefined, undefined, true);
    return { id, username: body.username ? String(body.username) : undefined };
  }

  async userFollowStatus(context: SendContext, scopedUserId: string): Promise<{
    username?: string;
    isUserFollowBusiness: boolean;
    isBusinessFollowUser?: boolean;
    usagePercent?: number;
  }> {
    if (this.config.META_MODE === "mock") {
      return {
        username: "demo_follower",
        isUserFollowBusiness: !scopedUserId.includes("not_follower"),
        isBusinessFollowUser: false,
        usagePercent: undefined,
      };
    }
    const url = new URL(`https://graph.instagram.com/${context.graphVersion}/${scopedUserId}`);
    url.searchParams.set("fields", "username,is_user_follow_business,is_business_follow_user");
    const body = await this.request(url, { headers: { Authorization: `Bearer ${context.token}` } });
    if (typeof body.is_user_follow_business !== "boolean") {
      throw new MetaApiError(
        "Meta did not return follower status. The Instagram user may not have granted messaging profile consent.",
        409,
        undefined,
        undefined,
        true,
      );
    }
    return {
      username: body.username ? String(body.username) : undefined,
      isUserFollowBusiness: body.is_user_follow_business,
      isBusinessFollowUser: typeof body.is_business_follow_user === "boolean" ? body.is_business_follow_user : undefined,
      usagePercent: positiveNumber(body.__usagePercent),
    };
  }

  async subscribeToWebhooks(context: SendContext): Promise<void> {
    if (this.config.META_MODE === "mock") return;
    const url = `https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/subscribed_apps`;
    const body = await this.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: ["comments", "messages", "messaging_postbacks"] }),
    }, "write");
    if (body.success !== true) throw new MetaAmbiguousError("Meta did not confirm the webhook subscription.");
  }

  async subscribedFields(context: SendContext): Promise<string[]> {
    if (this.config.META_MODE === "mock") return ["comments", "messages", "messaging_postbacks"];
    const url = `https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/subscribed_apps`;
    const body = await this.request(url, { headers: { Authorization: `Bearer ${context.token}` } });
    const entries = Array.isArray(body.data) ? body.data : [];
    const fields = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const subscribed = (entry as { subscribed_fields?: unknown }).subscribed_fields;
      if (Array.isArray(subscribed)) subscribed.forEach((field) => fields.add(String(field)));
    }
    return [...fields];
  }

  async listMedia(context: SendContext): Promise<Array<{
    id: string; caption?: string; mediaType?: string; permalink?: string; timestamp?: string;
  }>> {
    if (this.config.META_MODE === "mock") return [
      { id: "demo-reel-1", caption: "Тестовый Reel: напишите «гайд»", mediaType: "VIDEO", timestamp: new Date().toISOString() },
      { id: "demo-post-2", caption: "Тестовая публикация", mediaType: "IMAGE", timestamp: new Date(Date.now() - 86_400_000).toISOString() },
    ];
    const url = new URL(`https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/media`);
    url.searchParams.set("fields", "id,caption,media_type,permalink,timestamp");
    url.searchParams.set("limit", "50");
    const body = await this.request(url, { headers: { Authorization: `Bearer ${context.token}` } });
    const data = Array.isArray(body.data) ? body.data : [];
    return data.flatMap((item) => {
      if (!item || typeof item !== "object" || !("id" in item)) return [];
      const record = item as Record<string, unknown>;
      return [{
        id: String(record.id), caption: record.caption ? String(record.caption) : undefined,
        mediaType: record.media_type ? String(record.media_type) : undefined,
        permalink: record.permalink ? String(record.permalink) : undefined,
        timestamp: record.timestamp ? String(record.timestamp) : undefined,
      }];
    });
  }

  async recoveryMedia(context: SendContext, after?: string): Promise<RecoveryPage> {
    return this.recoveryRead(context, `${context.igUserId}/media`, "id,timestamp", after);
  }

  async recoveryComments(context: SendContext, mediaId: string, after?: string): Promise<RecoveryPage> {
    return this.recoveryRead(context, `${mediaId}/comments`, "id,text,timestamp,from", after);
  }

  async recoveryReplies(context: SendContext, commentId: string): Promise<RecoveryPage> {
    return this.recoveryRead(context, `${commentId}/replies`, "id");
  }

  private async recoveryRead(context: SendContext, edge: string, fields: string, after?: string): Promise<RecoveryPage> {
    if (this.config.META_MODE === "mock") return { data: [] };
    if (!/^\d+\/(media|comments|replies)$/.test(edge)) throw new Error("Invalid recovery edge.");
    // Never follow paging.next: it can contain an access token or a different host.
    const url = new URL(`https://graph.instagram.com/${context.graphVersion}/${edge}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "50");
    if (after) url.searchParams.set("after", after);
    return recoveryPage(await this.request(url, { headers: { Authorization: `Bearer ${context.token}` } }));
  }

  async refreshToken(context: SendContext): Promise<{ accessToken: string; expiresIn?: number }> {
    if (this.config.META_MODE === "mock") return { accessToken: context.token, expiresIn: 5_184_000 };
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", context.token);
    const body = await this.request(url);
    const accessToken = String(body.access_token ?? "");
    if (!accessToken) throw new MetaApiError("Meta did not return a refreshed token.", 502, undefined, undefined, true);
    return { accessToken, expiresIn: Number(body.expires_in ?? 0) || undefined };
  }

  async publicReply(context: SendContext, commentId: string, message: string) {
    if (this.config.META_MODE === "mock") return { externalId: `mock-public-${Date.now()}`, usagePercent: undefined, recipientId: undefined };
    const url = `https://graph.instagram.com/${context.graphVersion}/${commentId}/replies`;
    const body = await this.request(url, {
      method: "POST", headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }, "write");
    return sentResult(body, "id");
  }

  async hasPublicReply(context: SendContext, commentId: string, message: string): Promise<boolean> {
    if (this.config.META_MODE === "mock") return false;
    const url = new URL(`https://graph.instagram.com/${context.graphVersion}/${commentId}/replies`);
    url.searchParams.set("fields", "id,text,from");
    url.searchParams.set("limit", "100");
    const body = await this.request(url, { headers: { Authorization: `Bearer ${context.token}` } });
    const replies = Array.isArray(body.data) ? body.data : [];
    return replies.some((reply) => {
      if (!reply || typeof reply !== "object") return false;
      const record = reply as Record<string, unknown>;
      const from = record.from && typeof record.from === "object" ? record.from as Record<string, unknown> : {};
      return String(record.text ?? "") === message && (!from.id || String(from.id) === context.igUserId);
    });
  }

  async privateReply(
    context: SendContext,
    commentId: string,
    message: string,
    button?: { title: string; url: string },
    quickReply?: { title: string; payload: string },
  ) {
    if (this.config.META_MODE === "mock") return {
      externalId: `mock-private-${Date.now()}`, usagePercent: undefined, recipientId: "mock-user-demo_follower",
    };
    const messageBody = button
      ? { attachment: { type: "template", payload: {
          template_type: "button", text: message, buttons: [{ type: "web_url", title: button.title, url: button.url }],
        } } }
      : quickReply
        ? { attachment: { type: "template", payload: {
            template_type: "button", text: message,
            buttons: [{ type: "postback", title: quickReply.title, payload: quickReply.payload }],
          } } }
        : { text: message };
    const body = { recipient: { comment_id: commentId }, message: messageBody };
    const url = `https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/messages`;
    const result = await this.request(url, {
      method: "POST", headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "write");
    return sentResult(result, "message_id");
  }

  async directMessage(
    context: SendContext,
    scopedUserId: string,
    message: string,
    button?: { title: string; url: string },
    quickReply?: { title: string; payload: string },
  ) {
    if (this.config.META_MODE === "mock") return { externalId: `mock-direct-${Date.now()}`, usagePercent: undefined, recipientId: undefined };
    const messageBody = button
      ? { attachment: { type: "template", payload: {
          template_type: "button", text: message, buttons: [{ type: "web_url", title: button.title, url: button.url }],
        } } }
      : quickReply
        ? { attachment: { type: "template", payload: {
            template_type: "button", text: message,
            buttons: [{ type: "postback", title: quickReply.title, payload: quickReply.payload }],
          } } }
        : { text: message };
    const body = { recipient: { id: scopedUserId }, message: messageBody };
    const url = `https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/messages`;
    const result = await this.request(url, {
      method: "POST", headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "write");
    return sentResult(result, "message_id");
  }
}
