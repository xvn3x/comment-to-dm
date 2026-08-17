import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { pickPublicReply, ruleMatches, type InstagramComment, type RuleRecord } from "./rules.js";

export async function enqueueComment(sql: Db, comment: InstagramComment): Promise<"queued" | "duplicate" | "no_match" | "ignored_self"> {
  if (comment.isSelf) return "ignored_self";
  const rules = await sql<RuleRecord[]>`
    SELECT * FROM rules WHERE active = TRUE ORDER BY priority ASC, created_at ASC
  `;
  const rule = rules.find((candidate) => ruleMatches(candidate, comment));
  if (!rule) return "no_match";

  const eventId = randomUUID();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${comment.senderId}:${comment.mediaId}:${rule.id}`}, 0))`;
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
        INSERT INTO events (id, comment_id, media_id, sender_id, username, rule_id, status, processed_at)
        VALUES (${eventId}, ${comment.commentId}, ${comment.mediaId}, ${comment.senderId}, ${comment.username ?? null}, ${rule.id}, 'skipped_duplicate', NOW())
        ON CONFLICT (comment_id) DO NOTHING
      `;
      return "duplicate" as const;
    }

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO events (id, comment_id, media_id, sender_id, username, rule_id, status)
      VALUES (${eventId}, ${comment.commentId}, ${comment.mediaId}, ${comment.senderId}, ${comment.username ?? null}, ${rule.id}, 'queued')
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
        VALUES (${randomUUID()}, ${eventId}, 'public_reply', ${tx.json({ commentId: comment.commentId, message: publicMessage })})
      `;
    }
    if (rule.follow_gate_enabled) {
      await tx`
        INSERT INTO follow_gate_sessions (
          event_id, final_message, final_button_text, final_button_url,
          check_button_text, retry_message
        ) VALUES (
          ${eventId}, ${rule.dm_text}, ${rule.button_text}, ${rule.button_url},
          ${rule.follow_gate_button_text!}, ${rule.follow_gate_retry_text!}
        )
      `;
    }
    await tx`
      INSERT INTO jobs (id, event_id, kind, payload, next_attempt_at)
      VALUES (
        ${randomUUID()}, ${eventId}, 'private_reply',
        ${tx.json({
          commentId: comment.commentId,
          message: rule.follow_gate_enabled ? rule.follow_gate_prompt : rule.dm_text,
          button: !rule.follow_gate_enabled && rule.button_text && rule.button_url
            ? { title: rule.button_text, url: rule.button_url } : undefined,
          quickReply: rule.follow_gate_enabled
            ? { title: rule.follow_gate_button_text, payload: `follow_gate:${eventId}` } : undefined,
          followGate: rule.follow_gate_enabled,
        })},
        NOW()
      )
    `;
    return "queued" as const;
  });
}

export type InstagramMessagingAction = {
  senderId: string;
  interactionId: string;
  payload: string;
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
      });
    }
  }
  return actions;
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
