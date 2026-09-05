import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import {
  inboundRuleMatches,
  pickPublicReply,
  ruleMatches,
  type InstagramComment,
  type InstagramInboundMessage,
  type RuleRecord,
} from "./rules.js";

type EnqueueOptions = {
  publicBaseUrl?: string;
  recovery?: { commentCreatedAt: string; ruleId: string; ruleUpdatedAt: string; igUserId: string; alreadyReplied?: boolean };
};
type EnqueueResult = "queued" | "duplicate" | "no_match" | "ignored_self";

function trackedMaterialUrl(baseUrl: string | undefined, token: string): string {
  if (!baseUrl) throw new Error("PUBLIC_BASE_URL is required for a tracked follow-up link.");
  return new URL(`/r/${token}`, baseUrl).toString();
}

export async function enqueueComment(
  sql: Db,
  comment: InstagramComment,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (comment.isSelf) return "ignored_self";
  const rules = await sql<RuleRecord[]>`
    SELECT * FROM rules WHERE active = TRUE AND trigger_type = 'comment' ORDER BY priority ASC, created_at ASC
  `;
  const rule = rules.find((candidate) => ruleMatches(candidate, comment));
  if (!rule) return "no_match";
  const recovery = options.recovery;
  const commentTime = recovery ? Date.parse(recovery.commentCreatedAt) : undefined;
  if (recovery && (!Number.isFinite(commentTime) || commentTime! > Date.now()
    || commentTime! <= Date.now() - 7 * 86_400_000 || rule.id !== recovery.ruleId
    || rule.updated_at.toISOString() !== recovery.ruleUpdatedAt
    || commentTime! < rule.updated_at.getTime())) return "no_match";
  const expiresAt = commentTime === undefined ? undefined : new Date(commentTime + 7 * 86_400_000).toISOString();

  const eventId = randomUUID();
  const trackingToken = rule.direct_message_enabled && rule.button_url && rule.button_text
    ? randomUUID()
    : undefined;
  const finalButtonUrl = trackingToken
    ? trackedMaterialUrl(options.publicBaseUrl, trackingToken)
    : rule.button_url;

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${comment.senderId}:${comment.mediaId}:${rule.id}`}, 0))`;
    if (recovery) {
      const connected = await tx`SELECT ig_user_id FROM meta_connection WHERE singleton AND ig_user_id = ${recovery.igUserId}
        AND token_enc IS NOT NULL AND NOT outbound_paused FOR SHARE`;
      if (!connected.length) return "no_match" as const;
      // Pin the checked rule until enqueue commits; edits must not replay history under a new rule.
      const current = await tx`SELECT id FROM rules WHERE id = ${rule.id}
        AND active = TRUE
        AND date_trunc('milliseconds', updated_at) = ${rule.updated_at} FOR SHARE`;
      if (!current.length) return "no_match" as const;
      if (recovery.alreadyReplied) {
        await tx`INSERT INTO events (id, comment_id, media_id, sender_id, username,
          trigger_type, rule_id, status, error_message, processed_at)
          VALUES (${eventId}, ${comment.commentId}, ${comment.mediaId}, ${comment.senderId},
            ${comment.username ?? null}, 'comment', ${rule.id}, 'skipped_duplicate',
            'Recovery skipped a comment with an existing Instagram reply.', NOW())
          ON CONFLICT (comment_id) DO NOTHING`;
        return "duplicate" as const;
      }
    }
    const previous = await tx<{ id: string }[]>`
      SELECT id FROM events
      WHERE sender_id = ${comment.senderId}
        AND media_id = ${comment.mediaId}
        AND rule_id = ${rule.id}
        AND status IN ('queued', 'processing', 'sent')
      LIMIT 1
    `;
    if (previous.length) {
      await tx`
        INSERT INTO events (id, comment_id, media_id, sender_id, username, trigger_type, rule_id, status, processed_at)
        VALUES (${eventId}, ${comment.commentId}, ${comment.mediaId}, ${comment.senderId}, ${comment.username ?? null}, 'comment', ${rule.id}, 'skipped_duplicate', NOW())
        ON CONFLICT (comment_id) DO NOTHING
      `;
      return "duplicate" as const;
    }

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO events (id, comment_id, media_id, sender_id, username, trigger_type, rule_id, status)
      VALUES (${eventId}, ${comment.commentId}, ${comment.mediaId}, ${comment.senderId}, ${comment.username ?? null}, 'comment', ${rule.id}, 'queued')
      ON CONFLICT (comment_id) DO NOTHING
      RETURNING id
    `;
    if (!inserted.length) return "duplicate" as const;

    const publicMessage = rule.public_reply_enabled
      ? pickPublicReply(rule.public_replies, comment.commentId)
      : undefined;
    if (publicMessage) {
      await tx`
        INSERT INTO jobs (id, event_id, kind, payload)
        VALUES (${randomUUID()}, ${eventId}, 'public_reply', ${tx.json({ commentId: comment.commentId, message: publicMessage, expiresAt })})
      `;
    }
    if (trackingToken && rule.button_url) {
      await tx`
        INSERT INTO link_tracking (event_id, tracking_token, destination_url)
        VALUES (${eventId}, ${trackingToken}, ${rule.button_url})
      `;
    }
    if (rule.direct_message_enabled && rule.follow_up_enabled && trackingToken && rule.button_url && rule.button_text && rule.follow_up_text) {
      await tx`
        INSERT INTO follow_up_sessions (
          event_id, tracking_token, destination_url, material_button_text,
          follow_up_text, delay_minutes
        ) VALUES (
          ${eventId}, ${trackingToken}, ${rule.button_url}, ${rule.button_text},
          ${rule.follow_up_text}, ${rule.follow_up_delay_minutes}
        )
      `;
    }
    if (rule.direct_message_enabled && rule.follow_gate_enabled) {
      await tx`
        INSERT INTO follow_gate_sessions (
          event_id, final_message, final_button_text, final_button_url,
          check_button_text, retry_message
        ) VALUES (
          ${eventId}, ${rule.dm_text}, ${rule.button_text}, ${finalButtonUrl},
          ${rule.follow_gate_button_text!}, ${rule.follow_gate_retry_text!}
        )
      `;
    }
    if (rule.direct_message_enabled) {
      await tx`
        INSERT INTO jobs (id, event_id, kind, payload, next_attempt_at)
        VALUES (
          ${randomUUID()}, ${eventId}, 'private_reply',
          ${tx.json({
            commentId: comment.commentId,
            message: rule.follow_gate_enabled ? rule.follow_gate_prompt : rule.dm_text,
            button: !rule.follow_gate_enabled && rule.button_text && finalButtonUrl
              ? { title: rule.button_text, url: finalButtonUrl } : undefined,
            quickReply: rule.follow_gate_enabled
              ? { title: rule.follow_gate_button_text, payload: `follow_gate:${eventId}` } : undefined,
            followGate: rule.follow_gate_enabled,
            expiresAt,
          })},
          NOW()
        )
      `;
    }
    return "queued" as const;
  });
}

export async function enqueueInboundMessage(
  sql: Db,
  message: InstagramInboundMessage,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (message.isSelf) return "ignored_self";
  const rules = await sql<RuleRecord[]>`
    SELECT * FROM rules WHERE active = TRUE AND trigger_type = ${message.kind}
    ORDER BY priority ASC, created_at ASC
  `;
  const rule = rules.find((candidate) => inboundRuleMatches(candidate, message));
  if (!rule) return "no_match";

  const eventId = randomUUID();
  const trackingToken = rule.button_url && rule.button_text ? randomUUID() : undefined;
  const materialButtonUrl = trackingToken
    ? trackedMaterialUrl(options.publicBaseUrl, trackingToken)
    : rule.button_url;
  const mediaId = message.kind === "story_reply" ? message.storyId ?? "story" : "direct";

  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO events (id, comment_id, media_id, sender_id, trigger_type, rule_id, status)
      VALUES (${eventId}, ${message.messageId}, ${mediaId}, ${message.senderId}, ${message.kind}, ${rule.id}, 'queued')
      ON CONFLICT (comment_id) DO NOTHING
      RETURNING id
    `;
    if (!inserted.length) return "duplicate" as const;

    if (trackingToken && rule.button_url) {
      await tx`
        INSERT INTO link_tracking (event_id, tracking_token, destination_url)
        VALUES (${eventId}, ${trackingToken}, ${rule.button_url})
      `;
    }
    if (rule.follow_up_enabled && trackingToken && rule.button_url && rule.button_text && rule.follow_up_text) {
      await tx`
        INSERT INTO follow_up_sessions (
          event_id, scoped_user_id, tracking_token, destination_url, material_button_text,
          follow_up_text, delay_minutes
        ) VALUES (
          ${eventId}, ${message.senderId}, ${trackingToken}, ${rule.button_url}, ${rule.button_text},
          ${rule.follow_up_text}, ${rule.follow_up_delay_minutes}
        )
      `;
    }
    if (rule.follow_gate_enabled) {
      await tx`
        INSERT INTO follow_gate_sessions (
          event_id, scoped_user_id, final_message, final_button_text, final_button_url,
          check_button_text, retry_message
        ) VALUES (
          ${eventId}, ${message.senderId}, ${rule.dm_text}, ${rule.button_text}, ${materialButtonUrl},
          ${rule.follow_gate_button_text!}, ${rule.follow_gate_retry_text!}
        )
      `;
    }

    await tx`
      INSERT INTO jobs (id, event_id, kind, payload)
      VALUES (
        ${randomUUID()}, ${eventId}, 'direct_message',
        ${tx.json({
          scopedUserId: message.senderId,
          message: rule.follow_gate_enabled ? rule.follow_gate_prompt : rule.dm_text,
          button: !rule.follow_gate_enabled && rule.button_text && materialButtonUrl
            ? { title: rule.button_text, url: materialButtonUrl } : undefined,
          quickReply: rule.follow_gate_enabled
            ? { title: rule.follow_gate_button_text, payload: `follow_gate:${eventId}` } : undefined,
          followGate: rule.follow_gate_enabled,
          scheduleFollowUp: Boolean(rule.follow_up_enabled && !rule.follow_gate_enabled),
          expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
        })}
      )
    `;
    return "queued" as const;
  });
}

export type InstagramMessagingAction = {
  senderId: string;
  interactionId: string;
  payload: string;
  isSelf?: boolean;
};

export function extractMessagingActions(payload: unknown): InstagramMessagingAction[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = Array.isArray((payload as { entry?: unknown }).entry)
    ? (payload as { entry: unknown[] }).entry : [];
  const actions: InstagramMessagingAction[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const messaging = Array.isArray((entry as { messaging?: unknown }).messaging)
      ? (entry as { messaging: unknown[] }).messaging : [];
    for (const item of messaging) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const sender = record.sender && typeof record.sender === "object"
        ? record.sender as Record<string, unknown> : {};
      const message = record.message && typeof record.message === "object"
        ? record.message as Record<string, unknown> : {};
      const quickReply = message.quick_reply && typeof message.quick_reply === "object"
        ? message.quick_reply as Record<string, unknown> : {};
      const postback = record.postback && typeof record.postback === "object"
        ? record.postback as Record<string, unknown> : {};
      const actionPayload = quickReply.payload ?? postback.payload;
      if (!sender.id || typeof actionPayload !== "string") continue;
      const messageId = message.mid ?? postback.mid;
      actions.push({
        senderId: String(sender.id),
        interactionId: messageId ? String(messageId) : `${sender.id}:${record.timestamp ?? actionPayload}`,
        payload: actionPayload,
        ...((record.is_self === true || message.is_self === true || message.is_echo === true) ? { isSelf: true } : {}),
      });
    }
  }
  return actions;
}

export function extractInboundMessages(payload: unknown): InstagramInboundMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = Array.isArray((payload as { entry?: unknown }).entry)
    ? (payload as { entry: unknown[] }).entry : [];
  const messages: InstagramInboundMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const messaging = Array.isArray((entry as { messaging?: unknown }).messaging)
      ? (entry as { messaging: unknown[] }).messaging : [];
    for (const item of messaging) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const sender = record.sender && typeof record.sender === "object"
        ? record.sender as Record<string, unknown> : {};
      const recipient = record.recipient && typeof record.recipient === "object"
        ? record.recipient as Record<string, unknown> : {};
      const message = record.message && typeof record.message === "object"
        ? record.message as Record<string, unknown> : undefined;
      if (!message || !sender.id || !message.mid) continue;
      if (message.is_deleted === true || message.is_unsupported === true || message.quick_reply) continue;
      const replyTo = message.reply_to && typeof message.reply_to === "object"
        ? message.reply_to as Record<string, unknown> : {};
      const story = replyTo.story && typeof replyTo.story === "object"
        ? replyTo.story as Record<string, unknown> : undefined;
      messages.push({
        messageId: String(message.mid),
        senderId: String(sender.id),
        recipientId: recipient.id ? String(recipient.id) : undefined,
        text: typeof message.text === "string" ? message.text : "",
        kind: story ? "story_reply" : "direct_message",
        storyId: story?.id ? String(story.id) : undefined,
        isSelf: record.is_self === true || message.is_self === true || message.is_echo === true,
      });
    }
  }
  return messages;
}

export function extractComments(payload: unknown): InstagramComment[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = Array.isArray((payload as { entry?: unknown }).entry)
    ? (payload as { entry: unknown[] }).entry
    : [];
  const comments: InstagramComment[] = [];
  const append = (field: unknown, value: unknown) => {
    if (field !== "comments" || !value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const from = (record.from ?? {}) as Record<string, unknown>;
    const media = (record.media ?? {}) as Record<string, unknown>;
    if (!record.id || !media.id || !from.id || typeof record.text !== "string") return;
    comments.push({
      commentId: String(record.id),
      mediaId: String(media.id),
      senderId: String(from.id),
      username: from.username ? String(from.username) : undefined,
      text: record.text,
      isSelf: record.is_self === true || Boolean(from.self_ig_scoped_id),
    });
  };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const entryRecord = entry as Record<string, unknown>;
    append(entryRecord.field, entryRecord.value);
    const changes = Array.isArray((entry as { changes?: unknown }).changes)
      ? (entry as { changes: unknown[] }).changes
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      append((change as { field?: unknown }).field, (change as { value?: unknown }).value);
    }
  }
  return comments;
}
