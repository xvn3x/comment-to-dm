import { z } from "zod";
import { MetaApiError, type MetaClient, type RecoveryPage, type SendContext } from "./meta.js";
import { ruleMatches, type InstagramComment, type RuleRecord } from "./rules.js";

const WEEK = 7 * 86_400_000;
const cursorSchema = z.object({
  initialized: z.boolean().default(false),
  mediaIds: z.array(z.string().regex(/^\d+$/)).max(2000).default([]),
  mediaAfter: z.string().max(4096).optional(),
  commentAfter: z.string().max(4096).optional(),
  discoveryDone: z.boolean().default(false),
});
export type RecoveryCursor = z.infer<typeof cursorSchema>;
export type RecoveryComment = InstagramComment & { timestamp: string };
export type RecoveryIo = {
  beforeRead(): Promise<void>;
  usage(percent: number): Promise<void>;
  save(cursor: RecoveryCursor): Promise<void>;
  seen(commentId: string): Promise<boolean>;
  enqueue(comment: RecoveryComment, rule: RuleRecord, alreadyReplied: boolean): Promise<void>;
};

export function recoveryComment(raw: Record<string, unknown>, mediaId: string, ownId: string): RecoveryComment | undefined {
  const from = raw.from as { id?: unknown; username?: unknown; self_ig_scoped_id?: unknown } | undefined;
  if (typeof raw.id !== "string" || !/^\d+$/.test(raw.id) || typeof raw.text !== "string"
    || typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))
    || typeof from?.id !== "string" || !/^\d+$/.test(from.id)) return;
  return { commentId: raw.id, mediaId, senderId: from.id, text: raw.text, timestamp: raw.timestamp,
    username: typeof from.username === "string" ? from.username : undefined,
    isSelf: from.id === ownId || Boolean(from.self_ig_scoped_id) };
}

export function recoveryRule(rules: RuleRecord[], comment: RecoveryComment, startedAt: Date, now: number): RuleRecord | undefined {
  const time = Date.parse(comment.timestamp);
  if (comment.isSelf || !Number.isFinite(time) || time < startedAt.getTime()
    || time <= now - WEEK || time > now - 60_000) return;
  // Keep normal first-match priority. Never fall through to another rule to replay an old comment.
  const rule = rules.find((candidate) => ruleMatches(candidate, comment));
  return rule && time >= rule.updated_at.getTime() ? rule : undefined;
}

class BudgetReached extends Error {}
const missingObject = (error: unknown) => error instanceof MetaApiError && error.code === 100 && error.subcode === 33;

/** Bounded, resumable reads only. Writes go through the same enqueue path as webhooks. */
export async function recoverCommentPass(args: {
  meta: Pick<MetaClient, "recoveryMedia" | "recoveryComments" | "recoveryReplies">;
  context: SendContext;
  rules: RuleRecord[];
  seedMediaIds: string[];
  startedAt: Date;
  cursor: unknown;
  requestBudget: number;
  io: RecoveryIo;
  now?: number;
}): Promise<{ requests: number; queued: number; skipped: number; highUsage: boolean }> {
  const { meta, context, rules, io } = args;
  const now = args.now ?? Date.now();
  const cursor = cursorSchema.parse(args.cursor);
  let requests = 0;
  let queued = 0;
  let skipped = 0;
  let highUsage = false;
  const read = async (operation: () => Promise<RecoveryPage>) => {
    if (requests >= args.requestBudget || highUsage) throw new BudgetReached();
    await io.beforeRead();
    requests += 1;
    const result = await operation();
    if (result.usagePercent !== undefined) {
      await io.usage(result.usagePercent);
      highUsage = result.usagePercent >= 80;
    }
    return result;
  };
  if (!cursor.initialized) {
    cursor.mediaIds = [...new Set(args.seedMediaIds.filter((id) => /^\d+$/.test(id)))];
    if (cursor.mediaIds.length > 2000) throw new Error("recovery_media_scope_too_large");
    cursor.initialized = true;
    cursor.discoveryDone = !rules.some((rule) => rule.target_scope === "all");
    await io.save(cursor);
  }
  try {
    while (requests < args.requestBudget && !highUsage) {
      if (!cursor.mediaIds.length) {
        if (cursor.discoveryDone) {
          await io.save(cursorSchema.parse({}));
          break;
        }
        const page = await read(() => meta.recoveryMedia(context, cursor.mediaAfter));
        if (page.after && page.after === cursor.mediaAfter) throw new Error("recovery_cursor_did_not_advance");
        // Old Reels can receive new comments too; paginate the whole media list within the budget.
        cursor.mediaIds = page.data.flatMap((item) => typeof item.id === "string" && /^\d+$/.test(item.id) ? [item.id] : []);
        cursor.mediaAfter = page.after;
        cursor.discoveryDone = !page.after;
        await io.save(cursor);
        continue;
      }
      const mediaId = cursor.mediaIds[0];
      let page: RecoveryPage;
      try {
        page = await read(() => meta.recoveryComments(context, mediaId, cursor.commentAfter));
      } catch (error) {
        if (!missingObject(error)) throw error;
        // A deleted/inaccessible object must not starve every later Reel in this account.
        cursor.mediaIds.shift();
        cursor.commentAfter = undefined;
        await io.save(cursor);
        continue;
      }
      for (const item of page.data) {
        const comment = recoveryComment(item, mediaId, context.igUserId);
        if (!comment || await io.seen(comment.commentId)) continue;
        const rule = recoveryRule(rules, comment, args.startedAt, now);
        if (!rule) continue;
        let replies: RecoveryPage;
        try {
          replies = await read(() => meta.recoveryReplies(context, comment.commentId));
        } catch (error) {
          if (missingObject(error)) continue;
          throw error;
        }
        // Fail conservatively: an existing reply may have been sent by a person outside this app.
        // Persist the skip so a late webhook cannot then restart the same chain.
        const alreadyReplied = replies.data.length > 0 || Boolean(replies.after);
        await io.beforeRead(); // Revalidate account/lease immediately before enqueue, too.
        await io.enqueue(comment, rule, alreadyReplied);
        if (alreadyReplied) skipped += 1;
        else queued += 1;
      }
      if (page.after && page.after === cursor.commentAfter) throw new Error("recovery_cursor_did_not_advance");
      cursor.commentAfter = page.after;
      if (!page.after) cursor.mediaIds.shift();
      await io.save(cursor);
    }
  } catch (error) {
    // Re-read a partial page next time. Persisted event IDs make this safe even after a crash.
    if (!(error instanceof BudgetReached)) throw error;
  }
  return { requests, queued, skipped, highUsage };
}
