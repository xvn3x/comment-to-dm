import type { AppConfig } from "./config.js";

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly transient = false,
  ) {
    super(message);
  }
}

type MetaCredentials = {
  appId: string;
  appSecret: string;
  graphVersion: string;
};

type SendContext = {
  igUserId: string;
  token: string;
  graphVersion: string;
};

async function parseMetaResponse(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (body.error ?? {}) as Record<string, unknown>;
    throw new MetaApiError(
      String(detail.message ?? `Meta API returned HTTP ${response.status}`),
      response.status,
      typeof detail.code === "number" ? detail.code : undefined,
      Boolean(detail.is_transient),
    );
  }
  return body;
}

export class MetaClient {
  constructor(private readonly config: AppConfig) {}

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
    const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const short = await parseMetaResponse(shortResponse);
    const shortToken = String(short.access_token ?? "");
    const userId = String(short.user_id ?? "");
    if (!shortToken || !userId) throw new MetaApiError("Instagram did not return an access token.", 502);

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", credentials.appSecret);
    longUrl.searchParams.set("access_token", shortToken);
    const long = await parseMetaResponse(await fetch(longUrl));
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
    const body = await parseMetaResponse(await fetch(url, {
      headers: { Authorization: `Bearer ${context.token}` },
    }));
    return { id: String(body.user_id ?? body.id ?? context.igUserId), username: body.username ? String(body.username) : undefined };
  }

  async subscribeToComments(context: SendContext): Promise<void> {
    if (this.config.META_MODE === "mock") return;
    const url = `https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/subscribed_apps`;
    await parseMetaResponse(await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: ["comments"] }),
    }));
  }

  async listMedia(context: SendContext): Promise<Array<{
    id: string;
    caption?: string;
    mediaType?: string;
    permalink?: string;
    timestamp?: string;
  }>> {
    if (this.config.META_MODE === "mock") return [
      { id: "demo-reel-1", caption: "Тестовый Reel: напишите «гайд»", mediaType: "VIDEO", timestamp: new Date().toISOString() },
      { id: "demo-post-2", caption: "Тестовая публикация", mediaType: "IMAGE", timestamp: new Date(Date.now() - 86_400_000).toISOString() },
    ];
    const url = new URL(`https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/media`);
    url.searchParams.set("fields", "id,caption,media_type,permalink,timestamp");
    url.searchParams.set("limit", "50");
    const body = await parseMetaResponse(await fetch(url, {
      headers: { Authorization: `Bearer ${context.token}` },
    }));
    const data = Array.isArray(body.data) ? body.data : [];
    return data.flatMap((item) => {
      if (!item || typeof item !== "object" || !("id" in item)) return [];
      const record = item as Record<string, unknown>;
      return [{
        id: String(record.id),
        caption: record.caption ? String(record.caption) : undefined,
        mediaType: record.media_type ? String(record.media_type) : undefined,
        permalink: record.permalink ? String(record.permalink) : undefined,
        timestamp: record.timestamp ? String(record.timestamp) : undefined,
      }];
    });
  }

  async refreshToken(context: SendContext): Promise<{ accessToken: string; expiresIn?: number }> {
    if (this.config.META_MODE === "mock") return { accessToken: context.token, expiresIn: 5_184_000 };
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", context.token);
    const body = await parseMetaResponse(await fetch(url));
    return {
      accessToken: String(body.access_token ?? context.token),
      expiresIn: Number(body.expires_in ?? 0) || undefined,
    };
  }

  async publicReply(context: SendContext, commentId: string, message: string): Promise<string> {
    if (this.config.META_MODE === "mock") return `mock-public-${Date.now()}`;
    const url = `https://graph.instagram.com/${context.graphVersion}/${commentId}/replies`;
    const body = await parseMetaResponse(await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }));
    return String(body.id ?? "");
  }

  async privateReply(
    context: SendContext,
    commentId: string,
    message: string,
    button?: { title: string; url: string },
  ): Promise<string> {
    if (this.config.META_MODE === "mock") return `mock-private-${Date.now()}`;
    const body = button
      ? {
          recipient: { comment_id: commentId },
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "button",
                text: message,
                buttons: [{ type: "web_url", title: button.title, url: button.url }],
              },
            },
          },
        }
      : { recipient: { comment_id: commentId }, message: { text: message } };
    const url = `https://graph.instagram.com/${context.graphVersion}/${context.igUserId}/messages`;
    const result = await parseMetaResponse(await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    return String(result.message_id ?? "");
  }
}
