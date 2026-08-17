export type RuleRecord = {
  id: string;
  name: string;
  active: boolean;
  priority: number;
  trigger_type: "comment" | "direct_message" | "story_reply";
  target_scope: "all" | "specific";
  media_id: string | null;
  match_mode: "any" | "contains" | "exact";
  keywords: string[];
  public_reply_enabled: boolean;
  public_replies: string[];
  dm_text: string;
  button_text: string | null;
  button_url: string | null;
  follow_gate_enabled: boolean;
  follow_gate_prompt: string | null;
  follow_gate_button_text: string | null;
  follow_gate_retry_text: string | null;
  follow_up_enabled: boolean;
  follow_up_delay_minutes: number;
  follow_up_text: string | null;
  created_at: Date;
  updated_at: Date;
};

export type InstagramComment = {
  commentId: string;
  mediaId: string;
  senderId: string;
  username?: string;
  text: string;
  isSelf?: boolean;
};

export type InstagramInboundMessage = {
  messageId: string;
  senderId: string;
  recipientId?: string;
  text: string;
  kind: "direct_message" | "story_reply";
  storyId?: string;
  isSelf?: boolean;
};

export function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

export function ruleMatches(rule: RuleRecord, comment: InstagramComment): boolean {
  if (!rule.active) return false;
  if (rule.trigger_type !== "comment") return false;
  if (rule.target_scope === "specific" && rule.media_id !== comment.mediaId) return false;

  return textMatches(rule, comment.text);
}

export function inboundRuleMatches(rule: RuleRecord, message: InstagramInboundMessage): boolean {
  if (!rule.active || rule.trigger_type !== message.kind) return false;
  if (message.kind === "story_reply" && rule.target_scope === "specific" && rule.media_id !== message.storyId) return false;
  return textMatches(rule, message.text);
}

function textMatches(rule: RuleRecord, value: string): boolean {
  if (rule.match_mode === "any") return true;

  const text = normalizeText(value);
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
