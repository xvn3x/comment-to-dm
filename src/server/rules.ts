export type RuleRecord = {
  id: string;
  name: string;
  active: boolean;
  priority: number;
  target_scope: "all" | "specific";
  media_id: string | null;
  match_mode: "any" | "contains" | "exact";
  keywords: string[];
  public_reply_enabled: boolean;
  public_replies: string[];
  dm_text: string;
  button_text: string | null;
  button_url: string | null;
  created_at: Date;
  updated_at: Date;
};

export type InstagramComment = {
  commentId: string;
  mediaId: string;
  senderId: string;
  username?: string;
  text: string;
};

export function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

export function ruleMatches(rule: RuleRecord, comment: InstagramComment): boolean {
  if (!rule.active) return false;
  if (rule.target_scope === "specific" && rule.media_id !== comment.mediaId) return false;
  if (rule.match_mode === "any") return true;

  const text = normalizeText(comment.text);
  const keywords = rule.keywords.map(normalizeText).filter(Boolean);
  if (!keywords.length) return false;
  return rule.match_mode === "exact"
    ? keywords.some((keyword) => text === keyword)
    : keywords.some((keyword) => text.includes(keyword));
}

export function pickPublicReply(replies: string[], seed: string): string | undefined {
  if (!replies.length) return undefined;
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return replies[Math.abs(hash) % replies.length];
}
