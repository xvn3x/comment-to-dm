import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { pickPublicReply, ruleMatches, type InstagramComment, type RuleRecord } from "./rules.js";

export async function enqueueComment(sql: Db, comment: InstagramComment): Promise<"queued" | "duplicate" | "no_match"> {
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
    await tx`
      INSERT INTO jobs (id, event_id, kind, payload, next_attempt_at)
      VALUES (
        ${randomUUID()}, ${eventId}, 'private_reply',
        ${tx.json({
          commentId: comment.commentId,
          message: rule.dm_text,
          button: rule.button_text && rule.button_url ? { title: rule.button_text, url: rule.button_url } : undefined,
        })},
        NOW()
      )
    `;
    return "queued" as const;
  });
}

export function extractComments(payload: unknown): InstagramComment[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = Array.isArray((payload as { entry?: unknown }).entry)
    ? (payload as { entry: unknown[] }).entry
    : [];
  const comments: InstagramComment[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as { changes?: unknown }).changes)
      ? (entry as { changes: unknown[] }).changes
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object" || (change as { field?: unknown }).field !== "comments") continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const from = (record.from ?? {}) as Record<string, unknown>;
      const media = (record.media ?? {}) as Record<string, unknown>;
      if (!record.id || !media.id || !from.id || typeof record.text !== "string") continue;
      comments.push({
        commentId: String(record.id),
        mediaId: String(media.id),
        senderId: String(from.id),
        username: from.username ? String(from.username) : undefined,
        text: record.text,
      });
    }
  }
  return comments;
}
