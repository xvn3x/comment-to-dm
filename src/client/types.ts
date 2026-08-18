export type TriggerType = "comment" | "direct_message" | "story_reply";

export type HealthState = "healthy" | "degraded" | "rate_limited" | "reauth_required" | "permission_required" | "restricted" | "misconfigured";

export type Rule = {
  id: string;
  name: string;
  active: boolean;
  priority: number;
  trigger_type: TriggerType;
  target_scope: "all" | "specific";
  media_id: string | null;
  match_mode: "any" | "contains" | "exact";
  keywords: string[];
  public_reply_enabled: boolean;
  public_replies: string[];
  direct_message_enabled: boolean;
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
  analytics: { triggered_24h: number; direct_24h: number; opened_24h: number; failed_24h: number };
};

export type EventItem = {
  id: string;
  sender_id: string;
  username: string | null;
  status: string;
  error_message: string | null;
  rule_name: string | null;
  media_id: string;
  trigger_type: TriggerType;
  created_at: string;
  processed_at: string | null;
  link_delivered_at: string | null;
  link_clicked_at: string | null;
  link_click_count: number | null;
};

export type Dashboard = {
  connection: {
    app_id: string | null;
    graph_version: string;
    ig_user_id: string | null;
    username: string | null;
    token_expires_at: string | null;
    connected_at: string | null;
    outbound_paused: boolean;
    rate_limited_until: string | null;
    rate_limit_reason: string | null;
    last_meta_usage_percent: number | null;
    last_meta_response_at: string | null;
    health_state: HealthState;
    health_reason: string | null;
    health_since: string;
    next_health_probe_at: string | null;
    token_refresh_error: string | null;
    token_refresh_failures: number;
    subscription_healthy: boolean | null;
    subscription_last_checked_at: string | null;
    worker_heartbeat_at: string | null;
    last_webhook_at: string | null;
    last_webhook_error: string | null;
    unparsed_webhooks: number;
    surge_mode: boolean;
  };
  rules: Rule[];
  events: EventItem[];
  stats: { total_24h: number; sent_24h: number; failed_24h: number; deliveries_24h: number };
  analytics: {
    links: { delivered_24h: number; opened_24h: number };
  };
  queue: {
    pending: number;
    private_pending: number;
    public_pending: number;
    retrying: number;
    uncertain: number;
    failed: number;
    expired: number;
    oldest_seconds: number;
    throughput_per_minute: number;
  };
  urls: { oauthCallback: string; webhook: string; deauthorize: string; dataDeletion: string };
  metaMode: "mock" | "live";
};

export type EventDetails = {
  event: EventItem & { comment_id: string; rule_id: string | null };
  jobs: Array<{
    id: string;
    kind: "public_reply" | "private_reply" | "direct_message" | "follow_check" | "follow_up";
    status: string;
    attempts: number;
    ambiguous_attempts: number;
    last_error: string | null;
    last_error_code: string | null;
    last_error_action: string | null;
    external_id: string | null;
    created_at: string;
    updated_at: string;
    message: string | null;
    button: { title: string; url: string } | null;
  }>;
  link: { delivered_at: string | null; first_clicked_at: string | null; click_count: number } | null;
  followGate: { status: string; last_checked_at: string | null; completed_at: string | null; last_error: string | null } | null;
  followUp: { status: string; scheduled_at: string | null; clicked_at: string | null; sent_at: string | null; last_error: string | null } | null;
};

export type MediaItem = { id: string; caption?: string; mediaType?: string; permalink?: string; timestamp?: string };

export type RuleForm = {
  name: string;
  active: boolean;
  priority: number;
  triggerType: TriggerType;
  targetScope: "all" | "specific";
  mediaId: string;
  matchMode: "any" | "contains" | "exact";
  keywords: string;
  publicReplyEnabled: boolean;
  publicReplies: string;
  directMessageEnabled: boolean;
  dmText: string;
  buttonText: string;
  buttonUrl: string;
  followGateEnabled: boolean;
  followGatePrompt: string;
  followGateButtonText: string;
  followGateRetryText: string;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
  followUpText: string;
};

export type DeliveryKind = "public_reply" | "private_reply" | "direct_message" | "follow_up";

export type DeliveryBucket = { start: string; future: boolean; deliveries: number; byKind: Record<DeliveryKind, number> };

export type Analytics = {
  from: string;
  to: string;
  unit: "hour" | "day";
  retentionDays: number;
  totals: {
    deliveries: number;
    byKind: Record<DeliveryKind, number>;
    failed: number;
    linksDelivered: number;
    linksOpened: number;
    followGatePassed: number;
    followGatePending: number;
    followUpSent: number;
    followUpClicked: number;
  };
  buckets: DeliveryBucket[];
  rules: Array<{ id: string; triggered: number; direct: number; opened: number; failed: number }>;
};

export type PeriodKind = "today" | "date" | "range" | "all";

export type Period = { kind: PeriodKind; date: string; from: string; to: string };
