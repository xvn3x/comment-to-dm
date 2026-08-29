import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity, ArrowLeft, Camera, Check, ChevronRight, CircleAlert, CircleHelp, CirclePlay, Clock3, Copy, ExternalLink,
  FileText, Gauge, ImageIcon, Languages, Layers3, Link2, LockKeyhole, LogOut, MessageCircle,
  MessageCircleReply, Mic, Moon, MousePointerClick, Pause, Play, Plug, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck,
  Star, Sticker, Sun, Trash2, TriangleAlert, X, Zap,
} from "lucide-react";
import { api, ApiError } from "./api";
import { copy, type Copy as CopyText, type Language } from "./i18n";
import {
  addDays, fromDateInput, nextLocalMidnight, periodBounds, retentionMinDate, toDateInput, todayAnchor,
} from "./period";
import type {
  Analytics, Dashboard, DeliveryBucket, EventDetails, EventItem, MediaItem, Period, PeriodKind, Rule, RuleForm, TriggerType,
} from "./types";

type Screen = "automations" | "activity" | "connection" | "rule";
type Theme = "light" | "dark";

const defaultRule: RuleForm = {
  name: "Гайд из комментариев", active: true, priority: 100, triggerType: "comment",
  targetScope: "all", mediaId: "", matchMode: "contains", keywords: "гайд",
  publicReplyEnabled: true, publicReplies: "Отправили информацию в Direct ✉️\nПроверьте Direct — всё уже там 🙌",
  directMessageEnabled: true, dmText: "Спасибо за комментарий! Нажмите кнопку ниже, чтобы получить материал.",
  buttonText: "Получить гайд", buttonUrl: "https://example.com/guide",
  followGateEnabled: false, followGatePrompt: "Подпишитесь на аккаунт и нажмите кнопку ниже, чтобы получить материал.",
  followGateButtonText: "Готово", followGateRetryText: "Пока не вижу подписку. Подпишитесь и нажмите «Готово» ещё раз.",
  followUpEnabled: false, followUpDelayMinutes: 60,
  followUpText: "Не забудьте забрать материал — ссылка всё ещё доступна 👇",
};

function createDefaultRule(language: Language): RuleForm {
  if (language === "ru") return { ...defaultRule };
  return {
    ...defaultRule,
    name: "Comment guide",
    keywords: "guide",
    publicReplies: "Sent the information in Direct ✉️\nCheck your Direct — it is already there 🙌",
    dmText: "Thanks for your comment! Tap the button below to get the material.",
    buttonText: "Get the guide",
    followGatePrompt: "Follow the account and tap the button below to get the material.",
    followGateButtonText: "Done",
    followGateRetryText: "I cannot see your follow yet. Follow the account and tap “Done” again.",
    followUpText: "Do not forget to get the material — the link is still available 👇",
  };
}

const navItems: Array<{ id: Exclude<Screen, "rule">; icon: typeof Zap }> = [
  { id: "automations", icon: Zap }, { id: "activity", icon: Activity }, { id: "connection", icon: Plug },
];

function initialLanguage(): Language {
  const saved = localStorage.getItem("ctd-language");
  if (saved === "ru" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function initialTheme(): Theme {
  const saved = localStorage.getItem("ctd-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ruleToForm(item: Rule): RuleForm {
  return {
    name: item.name, active: item.active, priority: item.priority, triggerType: item.trigger_type,
    targetScope: item.target_scope, mediaId: item.media_id ?? "", matchMode: item.match_mode,
    keywords: item.keywords.join(", "), publicReplyEnabled: item.public_reply_enabled,
    publicReplies: item.public_replies.join("\n"), directMessageEnabled: item.direct_message_enabled,
    dmText: item.dm_text, buttonText: item.button_text ?? "", buttonUrl: item.button_url ?? "",
    followGateEnabled: item.follow_gate_enabled, followGatePrompt: item.follow_gate_prompt ?? defaultRule.followGatePrompt,
    followGateButtonText: item.follow_gate_button_text ?? defaultRule.followGateButtonText,
    followGateRetryText: item.follow_gate_retry_text ?? defaultRule.followGateRetryText,
    followUpEnabled: item.follow_up_enabled, followUpDelayMinutes: item.follow_up_delay_minutes,
    followUpText: item.follow_up_text ?? defaultRule.followUpText,
  };
}

function rulePayload(rule: RuleForm) {
  const directEnabled = rule.triggerType !== "comment" || rule.directMessageEnabled;
  return {
    ...rule,
    targetScope: rule.triggerType === "comment" ? rule.targetScope : "all",
    mediaId: rule.triggerType === "comment" && rule.targetScope === "specific" ? rule.mediaId : null,
    keywords: rule.matchMode === "any" ? [] : rule.keywords.split(",").map((word) => word.trim()).filter(Boolean),
    publicReplyEnabled: rule.triggerType === "comment" && rule.publicReplyEnabled,
    publicReplies: rule.triggerType === "comment" && rule.publicReplyEnabled
      ? rule.publicReplies.split("\n").map((value) => value.trim()).filter(Boolean).slice(0, 10) : [],
    directMessageEnabled: rule.triggerType === "comment" ? rule.directMessageEnabled : true,
    dmText: directEnabled ? rule.dmText : "", buttonText: directEnabled ? rule.buttonText || null : null,
    buttonUrl: directEnabled ? rule.buttonUrl || null : null,
    followGateEnabled: directEnabled && rule.followGateEnabled,
    followGatePrompt: directEnabled && rule.followGateEnabled ? rule.followGatePrompt : null,
    followGateButtonText: directEnabled && rule.followGateEnabled ? rule.followGateButtonText : null,
    followGateRetryText: directEnabled && rule.followGateEnabled ? rule.followGateRetryText : null,
    followUpEnabled: directEnabled && rule.followUpEnabled,
    followUpText: directEnabled && rule.followUpEnabled ? rule.followUpText : null,
  };
}

function triggerName(trigger: TriggerType, language: Language) {
  if (trigger === "comment") return copy[language].comment;
  if (trigger === "direct_message") return copy[language].inboundDirect;
  return copy[language].storyReply;
}

function statusName(status: string, language: Language) {
  const labels = language === "ru"
    ? { sent: "Отправлено", queued: "В очереди", processing: "Отправляется", retry_wait: "Ожидает повтора", uncertain: "Проверяется", failed: "Ошибка", dead_letter: "Не доставлено", expired: "Истекло", skipped: "Пропущено", skipped_duplicate: "Повтор" }
    : { sent: "Sent", queued: "Queued", processing: "Sending", retry_wait: "Waiting to retry", uncertain: "Verifying", failed: "Error", dead_letter: "Not delivered", expired: "Expired", skipped: "Skipped", skipped_duplicate: "Duplicate" };
  return (labels as Record<string, string>)[status] ?? status;
}

function healthName(state: Dashboard["connection"]["health_state"], language: Language) {
  const labels = language === "ru"
    ? { healthy: "Подключение исправно", degraded: "Временная проблема", rate_limited: "Пауза Meta", reauth_required: "Нужно переподключить Instagram", permission_required: "Не хватает разрешений", restricted: "Аккаунт временно ограничен", misconfigured: "Ошибка конфигурации" }
    : { healthy: "Connection is healthy", degraded: "Temporary issue", rate_limited: "Meta rate limit", reauth_required: "Reconnect Instagram", permission_required: "Permissions required", restricted: "Account is restricted", misconfigured: "Configuration error" };
  return labels[state];
}

function formatDate(value: string | null | undefined, language: Language, timeOnly = false) {
  if (!value) return "—";
  return new Date(value).toLocaleString(language === "ru" ? "ru-RU" : "en-US", timeOnly
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" className={`switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>;
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text?: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong>{text && <p>{text}</p>}</div>;
}

function BrandIcon({ large = false }: { large?: boolean }) {
  return <span className={`logo-mark ${large ? "large" : "small"}`} aria-hidden="true"><MessageCircleReply /></span>;
}

function TagInput({ values, onChange, placeholder, label }: { values: string[]; onChange: (values: string[]) => void; placeholder: string; label: string }) {
  const [draft, setDraft] = useState("");
  function commit(value = draft) {
    const next = value.trim().replace(/,$/, "");
    if (next && !values.some((item) => item.toLocaleLowerCase() === next.toLocaleLowerCase())) onChange([...values, next]);
    setDraft("");
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      if (draft.trim()) { event.preventDefault(); commit(); }
    }
    if (event.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
  }
  return <div className="tag-input" aria-label={label}>{values.map((value) => <span className="input-tag" key={value}>{value}<button type="button" onClick={() => onChange(values.filter((item) => item !== value))} aria-label={`${label}: ${value}`}><X /></button></span>)}<input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) window.setTimeout(() => commit(), 0); }} placeholder={placeholder} /></div>;
}

function VariantEditor({ values, onChange, addLabel, removeLabel }: { values: string[]; onChange: (values: string[]) => void; addLabel: string; removeLabel: string }) {
  const rows = values.length ? values : [""];
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  function appendVariant() {
    onChange([...rows, ""]);
    window.requestAnimationFrame(() => inputs.current[rows.length]?.focus());
  }
  return <div className="variant-editor"><div className="variant-list">{rows.map((value, index) => <div className="variant-row" key={index}><span>{String(index + 1).padStart(2, "0")}</span><input ref={(element) => { inputs.current[index] = element; }} value={value} onChange={(event) => { const next = [...rows]; next[index] = event.target.value; onChange(next); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); appendVariant(); } }} /><button type="button" onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))} aria-label={removeLabel}><Trash2 /></button></div>)}</div><button type="button" className="add-variant" onClick={appendVariant}><Plus />{addLabel}</button></div>;
}

function SettingToggle({ title, text, checked, onChange, disabled = false }: { title: string; text: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <div className={`setting-toggle ${disabled ? "disabled" : ""}`}><div><strong>{title}</strong><p>{text}</p></div><Toggle checked={checked} onChange={(value) => !disabled && onChange(value)} label={title} /></div>;
}

const periodOptions: Array<{ id: PeriodKind; key: "periodToday" | "periodDate" | "periodRange" | "periodAll" }> = [
  { id: "today", key: "periodToday" }, { id: "date", key: "periodDate" },
  { id: "range", key: "periodRange" }, { id: "all", key: "periodAll" },
];

function localeOf(language: Language) { return language === "ru" ? "ru-RU" : "en-US"; }

const TODAY_REFRESH_MS = 5_000;
const LIVE_RANGE_REFRESH_MS = 30_000;

type AnalyticsState = { key: string; data: Analytics | null; error: string };

function rangeKey(range: { from: Date; to: Date }) {
  return `${range.from.toISOString()}|${range.to.toISOString()}`;
}

function fetchAnalytics(range: { from: Date; to: Date }, signal: AbortSignal) {
  const query = `from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`;
  return api<Analytics>(`/api/analytics?${query}`, { signal });
}

/** Русские числовые формы: 1 отправка, 2 отправки, 5 отправок. */
function plural(count: number, language: Language, one: string, few: string, many: string) {
  if (language !== "ru") return count === 1 ? one : many;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function deliveryWord(count: number, language: Language, t: CopyText) {
  return plural(count, language, t.deliveryOne, t.deliveryFew, t.deliveryMany);
}

function HelpTip({ title, text, label }: { title: string; text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return <span className="help-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}><CircleHelp /></button>
    {open && <span className="help-popover" role="note"><strong>{title}</strong>{text}</span>}
  </span>;
}

function DeliveryBreakdown({ value, totals, t, disabled }: {
  value: string | number; totals: Analytics["totals"] | null; t: CopyText; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: Event) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: Event) {
      if ((event as globalThis.KeyboardEvent).key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const direct = totals ? totals.byKind.private_reply + totals.byKind.direct_message : 0;
  const row = (label: string, count: number, of?: number) => <div key={label}>
    <dt>{label}</dt>
    <dd>{count}{of === undefined ? null : <small> {t.ofDelivered} {of}</small>}</dd>
  </div>;

  return <span className="hero-block" ref={ref}>
    <button type="button" className="hero-number" disabled={disabled} aria-expanded={open}
      aria-label={open ? t.hideBreakdown : t.showBreakdown} onClick={() => setOpen(!open)}>{value}</button>
    <div className={`breakdown-popover ${open ? "open" : ""}`} aria-hidden={!open}>
      <p className="breakdown-title">{t.breakdownTitle}</p>
      <dl>
        {row(t.kindPublic, totals?.byKind.public_reply ?? 0)}
        {row(t.kindDirect, direct)}
        {row(t.kindFollowUp, totals?.byKind.follow_up ?? 0)}
      </dl>
      <p className="breakdown-title">{t.outcomesTitle}</p>
      <dl>
        {row(t.gatePassed, totals?.followGatePassed ?? 0)}
        {row(t.gatePending, totals?.followGatePending ?? 0)}
        {row(t.linkOpened, totals?.linksOpened ?? 0, totals?.linksDelivered ?? 0)}
        {row(t.followUpClicked, totals?.followUpClicked ?? 0, totals?.followUpSent ?? 0)}
      </dl>
      <p className="breakdown-hint">{t.breakdownHint}</p>
    </div>
  </span>;
}

function DeliveryChart({ buckets, unit, language, t }: { buckets: DeliveryBucket[]; unit: "hour" | "day"; language: Language; t: CopyText }) {
  const [active, setActive] = useState<number | null>(null);
  const locale = localeOf(language);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.deliveries));
  const step = Math.max(1, Math.ceil(buckets.length / 6));
  const current = active === null ? undefined : buckets[active];

  function axisLabel(bucket: DeliveryBucket) {
    const date = new Date(bucket.start);
    return unit === "hour"
      ? String(date.getHours()).padStart(2, "0")
      : date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
  }

  function bucketTitle(bucket: DeliveryBucket) {
    const start = new Date(bucket.start);
    if (unit === "day") return start.toLocaleDateString(locale, { day: "numeric", month: "long" });
    const end = new Date(start.getTime() + 3_600_000);
    const time = (value: Date) => value.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return `${time(start)} — ${time(end)}`;
  }

  function move(offset: number) {
    setActive((value) => Math.min(buckets.length - 1, Math.max(0, value === null ? buckets.length - 1 : value + offset)));
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(buckets.length - 1); }
    else if (event.key === "Escape") setActive(null);
  }

  const directCount = current ? current.byKind.private_reply + current.byKind.direct_message : 0;
  const position = active === null ? 0 : ((active + 0.5) / buckets.length) * 100;
  // Три положения вместо точного следования за курсором: подсказка никогда не выходит за карточку на 320 px.
  const anchor = position < 34 ? "start" : position > 66 ? "end" : "center";
  const summary = current
    ? `${bucketTitle(current)}: ${current.deliveries ? `${current.deliveries} ${deliveryWord(current.deliveries, language, t)}` : t.noDeliveries}`
    : "";

  return <div className="chart-shell">
    {current && <div className={`chart-tooltip-layer ${anchor}`}><div className="chart-tooltip">
      <strong>{bucketTitle(current)}</strong>
      <em>{current.deliveries ? `${current.deliveries} ${deliveryWord(current.deliveries, language, t)}` : t.noDeliveries}</em>
      {current.byKind.public_reply > 0 && <span>{t.kindPublic}<b>{current.byKind.public_reply}</b></span>}
      {directCount > 0 && <span>{t.kindDirect}<b>{directCount}</b></span>}
      {current.byKind.follow_up > 0 && <span>{t.kindFollowUp}<b>{current.byKind.follow_up}</b></span>}
    </div></div>}
    <div className="hourly-chart" role="group" tabIndex={0} aria-label={t.chartLabel}
      onKeyDown={keyDown} onMouseLeave={() => setActive(null)} onBlur={() => setActive(null)}>
      {buckets.map((bucket, index) => <div key={bucket.start}
        className={`bar-slot ${active === index ? "active" : ""} ${bucket.future ? "future" : ""}`}
        onMouseEnter={() => setActive(index)} onClick={() => setActive(index)}>
        <span className="bar-track"><i style={{ height: `${Math.max(bucket.deliveries ? 8 : 2, (bucket.deliveries / max) * 100)}%` }} /></span>
        <small>{(buckets.length - 1 - index) % step === 0 ? axisLabel(bucket) : ""}</small>
      </div>)}
    </div>
    <p className="sr-only" aria-live="polite">{summary}</p>
  </div>;
}

function InstagramPreview({ rule, username, language, t, directEnabled }: {
rule: RuleForm; username: string | null | undefined; language: Language; t: CopyText; directEnabled: boolean;
}) {
  const reply = rule.publicReplies.split("\n").find(Boolean) ?? t.commentReply;
  const account = username ?? "studio.mono";
  const initials = account.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "IG";
  const accountRoot = account.split(/[._-]/).filter(Boolean)[0] || "Instagram";
  const displayName = accountRoot.length <= 3 ? accountRoot.toUpperCase() : accountRoot.replace(/^./, (letter) => letter.toUpperCase());
  const message = rule.followGateEnabled ? rule.followGatePrompt : rule.dmText;
  const systemMessage = <div className="ig-system"><strong>{account}</strong>{language === "ru" ? " написал(-а) вам о комментарии, который вы добавили к его/ее публикации." : " messaged you about a comment you left on their post."}<b>{language === "ru" ? "Посмотреть публикацию" : "View post"}</b></div>;
  const avatar = <span className="ig-avatar" aria-hidden="true">{initials}</span>;
  return <section className="preview-card card"><div className="preview-heading"><strong>{t.preview}</strong><span><Camera />Instagram Direct</span></div><div className="phone-preview">
    <div className="phone-top"><ChevronRight className="preview-back" /><span className="avatar">{initials}</span><div><strong>{displayName}</strong><small>{account}</small></div></div>
    <div className="phone-body">{directEnabled ? <>
      <div className="ig-thread"><time>06:39</time>{rule.triggerType === "comment" && systemMessage}<div className="ig-message-row">{avatar}<div className="ig-bubble"><span>{message || t.directMessage}</span>{(rule.followGateEnabled ? rule.followGateButtonText : rule.buttonText) && <button type="button">{rule.followGateEnabled ? rule.followGateButtonText : rule.buttonText}</button>}</div></div>
        {rule.followGateEnabled && <><div className="ig-outgoing">{rule.followGateButtonText || t.check}</div><div className="ig-new-messages"><span />{language === "ru" ? "Новые сообщения" : "New messages"}<span /></div><time>06:40</time>{rule.triggerType === "comment" && systemMessage}<div className="ig-message-row">{avatar}<div className="ig-bubble retry"><span>{rule.followGateRetryText || t.notFollowing}</span><button type="button">{rule.followGateButtonText || t.check}</button></div></div></>}
      </div>
    </> : <div className="preview-only-comment"><MessageCircle /><strong>{language === "ru" ? "Только публичный ответ" : "Public reply only"}</strong><p>{reply}</p></div>}</div>
    <div className="phone-input"><span><Camera /></span><em>{language === "ru" ? "Напишите сообщение…" : "Message…"}</em><Mic /><ImageIcon /><Sticker /><Plus /></div>
  </div><p className="preview-note">{language === "ru" ? "Так это увидит человек в Instagram. Ответ под комментарием отправляется отдельно." : "This is what the person sees in Instagram. The public comment reply is sent separately."}</p></section>;
}

export function App() {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [screen, setScreen] = useState<Screen>("automations");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("error") ?? "");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rule, setRule] = useState<RuleForm>(() => createDefaultRule(initialLanguage()));
  const [metaConfig, setMetaConfig] = useState({ appId: "", appSecret: "", graphVersion: "v25.0" });
  const metaConfigDirty = useRef(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mockComment, setMockComment] = useState("гайд");
  const [eventFilter, setEventFilter] = useState<"all" | "sent" | "failed">("all");
  const [eventSearch, setEventSearch] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<EventDetails | null>(null);
  const [dayAnchor, setDayAnchor] = useState(todayAnchor);
  const [period, setPeriod] = useState<Period>(() => {
    const today = todayAnchor();
    const start = fromDateInput(today);
    return { kind: "today", date: today, from: toDateInput(addDays(start ?? new Date(), -6)), to: today };
  });
  const [analyticsState, setAnalyticsState] = useState<AnalyticsState>({ key: "", data: null, error: "" });
  const t = copy[language];

  const connected = Boolean(dashboard?.connection.ig_user_id);
  const health = dashboard?.connection.health_state ?? "healthy";
  const healthBlocked = ["reauth_required", "permission_required", "restricted", "misconfigured"].includes(health);
  const directEnabled = rule.triggerType !== "comment" || rule.directMessageEnabled;
  const bounds = useMemo(() => periodBounds(period, dayAnchor), [period, dayAnchor]);
  const boundsRef = useRef<{ from: Date; to: Date } | null>(null);
  const analyticsRunRef = useRef(0);
  const analyticsAbortRef = useRef<AbortController | null>(null);
  const analyticsInFlightRef = useRef("");
  const analyticsLoadedAtRef = useRef(0);
  const analyticsStateRef = useRef(analyticsState);
  const analyticsErrorTextRef = useRef(t.analyticsError);
  const screenRef = useRef(screen);
  const periodKindRef = useRef(period.kind);
  const dashboardInFlightRef = useRef(false);

  // Цифры показываем только вместе с тем диапазоном, для которого они были запрошены.
  const activeKey = typeof bounds === "string" ? "" : rangeKey(bounds);
  const analytics = activeKey && analyticsState.key === activeKey ? analyticsState.data : null;
  const analyticsError = analyticsState.key === activeKey ? analyticsState.error : "";
  const openRate = analytics && analytics.totals.linksDelivered > 0
    ? Math.round((analytics.totals.linksOpened / analytics.totals.linksDelivered) * 100) : null;
  const deliveries = analytics?.totals.deliveries ?? null;
  const failedCount = analytics?.totals.failed ?? null;
  const ruleStats = useMemo(
    () => new Map((analytics?.rules ?? []).map((item) => [item.id, item])),
    [analytics],
  );
  const periodLabel = period.kind === "today" ? t.deliveriesToday
    : period.kind === "date" ? t.deliveriesDay
      : period.kind === "range" ? t.deliveriesPeriod : t.deliveriesAll;
  const periodMessage = typeof bounds === "string"
    ? (bounds === "too_long" ? t.periodTooLong : t.periodInvalid) : analyticsError;
  const minDate = retentionMinDate(dayAnchor);
  const maxDate = dayAnchor;

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("ctd-theme", theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = language; localStorage.setItem("ctd-language", language); }, [language]);
  useEffect(() => {
    const markMetaConfigDirty = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest(".connection-form")) metaConfigDirty.current = true;
    };
    document.addEventListener("input", markMetaConfigDirty, true);
    return () => document.removeEventListener("input", markMetaConfigDirty, true);
  }, []);

  /**
   * Активный запрос аналитики всегда один: предыдущий отменяется, поздний ответ
   * отбрасывается по generation id, результат сохраняется вместе со своим диапазоном.
   */
  async function loadAnalytics(range: { from: Date; to: Date }) {
    const key = rangeKey(range);
    if (analyticsInFlightRef.current === key) return;
    analyticsAbortRef.current?.abort();
    const controller = new AbortController();
    const run = ++analyticsRunRef.current;
    analyticsAbortRef.current = controller;
    analyticsInFlightRef.current = key;
    try {
      const data = await fetchAnalytics(range, controller.signal);
      if (run !== analyticsRunRef.current) return;
      analyticsLoadedAtRef.current = Date.now();
      setAnalyticsState({ key, data, error: "" });
    } catch {
      if (controller.signal.aborted || run !== analyticsRunRef.current) return;
      setAnalyticsState({ key, data: null, error: analyticsErrorTextRef.current });
    } finally {
      if (analyticsInFlightRef.current === key) analyticsInFlightRef.current = "";
      if (analyticsAbortRef.current === controller) analyticsAbortRef.current = null;
    }
  }

  async function refresh() {
    const data = await api<Dashboard>("/api/dashboard");
    setDashboard(data);
    if (!metaConfigDirty.current) {
      setMetaConfig((value) => ({ ...value, appId: data.connection.app_id ?? "", graphVersion: data.connection.graph_version ?? "v25.0" }));
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") || params.has("connected")) window.history.replaceState({}, "", window.location.pathname);
    api<{ authenticated: boolean }>("/api/session").then(async (session) => {
      setAuthenticated(session.authenticated); if (session.authenticated) await refresh();
    }).catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    analyticsStateRef.current = analyticsState;
    analyticsErrorTextRef.current = t.analyticsError;
    screenRef.current = screen;
    periodKindRef.current = period.kind;
  });

  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const wait = Math.max(1_000, nextLocalMidnight().getTime() - Date.now() + 1_000);
      timer = window.setTimeout(() => {
        setDayAnchor(todayAnchor());
        schedule();
      }, wait);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      // Вкладка могла простоять открытой через полночь: якорь дня подтягиваем и по тику.
      const anchor = todayAnchor();
      setDayAnchor((value) => (value === anchor ? value : anchor));
      if (!dashboardInFlightRef.current) {
        dashboardInFlightRef.current = true;
        void refresh().catch(() => undefined).finally(() => { dashboardInFlightRef.current = false; });
      }
      if (screenRef.current !== "automations") return;
      const live = boundsRef.current;
      // Завершённый период уже загружен и измениться не может.
      if (!live || live.to.getTime() <= Date.now()) return;
      const minInterval = periodKindRef.current === "today" ? TODAY_REFRESH_MS : LIVE_RANGE_REFRESH_MS;
      if (Date.now() - analyticsLoadedAtRef.current < minInterval - 250) return;
      void loadAnalytics(live);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [authenticated]);

  useEffect(() => {
    boundsRef.current = typeof bounds === "string" ? null : bounds;
    if (!authenticated || screen !== "automations" || typeof bounds === "string") return;
    const key = rangeKey(bounds);
    const cached = analyticsStateRef.current;
    if (bounds.to.getTime() <= Date.now() && cached.key === key && cached.data) return;
    void loadAnalytics(bounds);
    return () => {
      analyticsAbortRef.current?.abort();
      analyticsAbortRef.current = null;
      analyticsInFlightRef.current = "";
    };
  }, [authenticated, screen, bounds]);

  useEffect(() => {
    if (screen !== "rule" || !connected || media.length) return;
    api<MediaItem[]>("/api/meta/media").then(setMedia).catch(() => setError(language === "ru" ? "Не удалось загрузить публикации Instagram." : "Could not load Instagram publications."));
  }, [screen, connected, media.length, language]);


  const filteredEvents = useMemo(() => (dashboard?.events ?? []).filter((event) => {
    const statusMatch = eventFilter === "all" || (eventFilter === "sent" ? event.status === "sent" : ["failed", "dead_letter", "expired"].includes(event.status));
    const search = eventSearch.trim().toLowerCase();
    return statusMatch && (!search || (event.username ?? "").toLowerCase().includes(search) || (event.rule_name ?? "").toLowerCase().includes(search));
  }), [dashboard?.events, eventFilter, eventSearch]);

  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/api/login", { method: "POST", body: JSON.stringify({ password }) }); setAuthenticated(true); await refresh(); }
    catch { setError(language === "ru" ? "Неверный пароль или слишком много попыток." : "Wrong password or too many attempts."); }
    finally { setBusy(false); }
  }

  async function logout() { await api("/api/logout", { method: "POST" }); setAuthenticated(false); setDashboard(null); }

  async function saveRule(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api(editingId ? `/api/rules/${editingId}` : "/api/rules", { method: editingId ? "PUT" : "POST", body: JSON.stringify(rulePayload(rule)) });
      setScreen("automations"); setEditingId(null); setRule(createDefaultRule(language)); await refresh();
    } catch (caught) { setError(caught instanceof ApiError ? caught.message : language === "ru" ? "Не удалось сохранить правило." : "Could not save the rule."); }
    finally { setBusy(false); }
  }

  function openRule(item?: Rule) {
    setEditingId(item?.id ?? null); setRule(item ? ruleToForm(item) : createDefaultRule(language)); setScreen("rule"); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggleRule(item: Rule, active: boolean) {
    try { await api(`/api/rules/${item.id}`, { method: "PUT", body: JSON.stringify(rulePayload({ ...ruleToForm(item), active })) }); await refresh(); }
    catch { setError(language === "ru" ? "Не удалось изменить правило." : "Could not update the rule."); }
  }

  async function removeRule(item: Rule) {
    if (!window.confirm(t.confirmDelete)) return;
    await api(`/api/rules/${item.id}`, { method: "DELETE" }); await refresh();
  }

  async function queueAction(action: "pause" | "resume" | "retry-failed") {
    setBusy(true); setError("");
    try { await api(`/api/queue/${action}`, { method: "POST" }); await refresh(); }
    catch { setError(language === "ru" ? "Не удалось изменить очередь." : "Could not update the queue."); }
    finally { setBusy(false); }
  }

  async function saveMeta(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/api/meta/config", { method: "POST", body: JSON.stringify(metaConfig) }); const { url } = await api<{ url: string }>("/api/meta/oauth-url"); window.location.assign(url); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : "Meta configuration failed"); setBusy(false); }
  }

  async function connectExisting() {
    setBusy(true); setError("");
    try { const { url } = await api<{ url: string }>("/api/meta/oauth-url"); window.location.assign(url); }
    catch { setError(language === "ru" ? "Сначала сохраните App ID и App Secret." : "Save App ID and App Secret first."); setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm(t.confirmDisconnect)) return;
    await api("/api/meta/connection", { method: "DELETE" }); await refresh();
  }

  async function healthCheck() {
    setBusy(true); setError("");
    try { await api("/api/meta/health-check", { method: "POST" }); await refresh(); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : "Health check failed"); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }

  async function openEvent(event: EventItem) {
    setSelectedEvent(null); setScreen("activity");
    try { setSelectedEvent(await api<EventDetails>(`/api/events/${event.id}`)); }
    catch { setError(language === "ru" ? "Не удалось открыть событие." : "Could not load the event."); }
  }

  async function simulate() {
    setBusy(true); setError("");
    try {
      const result = await api<{ result: string }>("/api/mock/comment", { method: "POST", body: JSON.stringify({ text: mockComment, mediaId: "demo-reel-1", username: `demo_${Date.now()}` }) });
      if (result.result === "no_match") setError(language === "ru" ? "Ни одно активное правило не подошло." : "No active rule matched.");
      await new Promise((resolve) => window.setTimeout(resolve, 1200)); await refresh();
    } finally { setBusy(false); }
  }

  if (authenticated === null) return <main className="loading-screen"><div className="loader" aria-label={t.loading} /></main>;

  if (!authenticated) return <main className="login-page">
    <div className="login-toolbar"><a className="icon-button" href="https://t.me/xvn3x_ai" target="_blank" rel="noreferrer" aria-label={t.telegramChannel} title={t.telegramChannel}><Send size={19} /></a><button className="icon-button" onClick={() => setLanguage(language === "ru" ? "en" : "ru")} aria-label={t.language}><Languages size={19} /><span>{language.toUpperCase()}</span></button><button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={t.appearance}>{theme === "light" ? <Moon size={19} /> : <Sun size={19} />}</button></div>
    <section className="login-card"><BrandIcon large /><p className="kicker">COMMENT TO DM · {t.selfHosted.toUpperCase()}</p><h1>{t.loginTitle}</h1><p className="lead">{t.loginText}</p>
      <div className="trust-row"><span><ShieldCheck />{t.selfHosted}</span><span><LockKeyhole />{t.encrypted}</span><span><Camera />{t.officialApi}</span></div>
      <form onSubmit={login} className="login-form"><label>{t.password}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" /></label>{error && <div className="inline-error"><CircleAlert />{error}</div>}<button className="button primary wide" disabled={busy}>{busy ? `${t.login}…` : t.login}<ChevronRight /></button></form>
    </section>
  </main>;

  function navigate(next: Exclude<Screen, "rule">) { setScreen(next); setSelectedEvent(null); window.scrollTo({ top: 0, behavior: "smooth" }); }

  return <div className="app-shell">
    <header className="topbar"><div className="topbar-main"><button className="brand-button" onClick={() => navigate("automations")}><BrandIcon /><strong>Comment to DM</strong></button><div className="topbar-tools">
      <a className="topbar-icon" href="https://t.me/xvn3x_ai" target="_blank" rel="noreferrer" aria-label={t.telegramChannel} title={t.telegramChannel}><Send /></a>
      <button type="button" className="topbar-icon" onClick={() => setLanguage(language === "ru" ? "en" : "ru")}
        aria-label={`${t.language}: ${language === "ru" ? "Русский" : "English"}`}><Languages /><span>{language.toUpperCase()}</span></button>
      <button type="button" className="topbar-icon" onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        aria-label={`${t.appearance}: ${theme === "light" ? t.light : t.dark}`}>{theme === "light" ? <Moon /> : <Sun />}</button>
      <span className="topbar-divider" aria-hidden="true" />
      <div className="account-menu"><span className={`live-dot ${connected ? "online" : ""}`} /><span>{connected ? `@${dashboard?.connection.username ?? "Instagram"}` : t.disconnected}</span><button onClick={() => void logout()} aria-label={t.logout}><LogOut /><span>{t.logout}</span></button></div>
    </div></div>
      <nav>{navItems.map(({ id, icon: Icon }) => <button key={id} className={screen === id ? "active" : ""} aria-current={screen === id ? "page" : undefined} onClick={() => navigate(id)}><Icon />{t[id]}</button>)}</nav></header>
    {error && <div className="global-notice" role="alert"><CircleAlert /><span>{error}</span><button onClick={() => setError("")} aria-label={language === "ru" ? "Закрыть" : "Close"}><X /></button></div>}
    <main className="page-shell">{screen === "automations" && DashboardView()}{screen === "activity" && ActivityView()}{screen === "connection" && ConnectionView()}{screen === "rule" && RuleEditor()}</main>
    {screen !== "rule" && <footer className="page-footer"><p>{t.dataText}</p><div className="page-footer-links"><a className="footer-star" href="https://github.com/xvn3x/comment-to-dm" target="_blank" rel="noreferrer"><Star />{t.starGithub}</a><a href="/privacy" target="_blank" rel="noreferrer">{t.privacyPolicy}<ExternalLink /></a></div></footer>}
    <nav className="bottom-nav">{navItems.map(({ id, icon: Icon }) => <button key={id} className={screen === id ? "active" : ""} aria-current={screen === id ? "page" : undefined} onClick={() => navigate(id)}><Icon /><span>{t[id]}</span></button>)}</nav>
  </div>;

  function PageTitle({ title, eyebrow, subtitle, action, compact = false }: { title: string; eyebrow?: string; subtitle?: string; action?: ReactNode; compact?: boolean }) {
    return <div className={`page-title ${compact ? "compact" : ""}`}><div><p className="kicker">{eyebrow ?? `${t.today} · ${new Date().toLocaleDateString(language === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "long" })}`}</p><h1>{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{action}</div>;
  }

  function DashboardView() {
    const queueState = dashboard?.connection.outbound_paused || healthBlocked ? "paused" : (dashboard?.queue.pending ?? 0) > 0 ? "running" : "idle";
    return <><PageTitle title={t.dashboardTitle} action={<button className="button primary" onClick={() => openRule()}><Plus />{t.createRule}</button>} />
      <section className="dashboard-grid"><article className="card delivery-card"><div className="delivery-head"><div><DeliveryBreakdown value={deliveries ?? "—"} totals={analytics?.totals ?? null} t={t} disabled={!analytics} /><span className="hero-caption">{periodLabel}<HelpTip title={t.whatCounts} text={`${t.whatCountsText} ${t.periodHint}`} label={t.whatCounts} /></span></div><span className={`state-badge ${queueState}`}><span />{queueState === "paused" ? t.queuePaused : t.queueRunning}</span></div><p className="card-explainer">{language === "ru" ? "Ответы на комментарии и сообщения проходят через надёжную очередь и переживают перезапуск сервера." : "Comment replies and messages use a durable queue and survive server restarts."}</p><div className="period-controls"><div className="segmented" role="group" aria-label={t.today}>{periodOptions.map((option) => <button key={option.id} type="button" aria-pressed={period.kind === option.id} className={period.kind === option.id ? "active" : ""} onClick={() => setPeriod((value) => ({ ...value, kind: option.id }))}>{t[option.key]}</button>)}</div>{period.kind === "date" && <label className="period-field"><span>{t.periodDate}</span><input type="date" value={period.date} min={minDate} max={maxDate} onChange={(event) => setPeriod((value) => ({ ...value, date: event.target.value }))} /></label>}{period.kind === "range" && <div className="period-fields"><label className="period-field"><span>{t.periodFrom}</span><input type="date" value={period.from} min={minDate} max={maxDate} onChange={(event) => setPeriod((value) => ({ ...value, from: event.target.value }))} /></label><label className="period-field"><span>{t.periodTo}</span><input type="date" value={period.to} min={minDate} max={maxDate} onChange={(event) => setPeriod((value) => ({ ...value, to: event.target.value }))} /></label></div>}</div>{periodMessage ? <p className="chart-message" role="alert">{periodMessage}</p> : analytics && typeof bounds !== "string" ? <DeliveryChart buckets={analytics.buckets} unit={analytics.unit} language={language} t={t} /> : <div className="chart-placeholder" aria-hidden="true" />}</article>
        <article className="card queue-card"><Metric icon={<Layers3 />} label={t.queue} value={dashboard?.queue.pending ?? 0} /><Metric icon={<Gauge />} label={t.apiSpeed} value={`${(dashboard?.queue.throughput_per_minute ?? 0).toFixed(1)}/min`} /><Metric icon={<MousePointerClick />} label={t.openedLink} value={analytics && openRate != null ? `${openRate}%` : "—"} tone="success" /><Metric icon={<TriangleAlert />} label={t.errors} value={failedCount ?? "—"} tone={failedCount ? "danger" : undefined} /><div className="queue-actions"><button className="button secondary" disabled={busy} onClick={() => void queueAction(dashboard?.connection.outbound_paused ? "resume" : "pause")}>{dashboard?.connection.outbound_paused ? <Play /> : <Pause />}{dashboard?.connection.outbound_paused ? t.resume : t.pause}</button><button className="button secondary" disabled={busy} onClick={() => void healthCheck()}><RefreshCw />{t.check}</button></div></article></section>
      {(health !== "healthy" || dashboard?.connection.surge_mode || (dashboard?.queue.failed ?? 0) > 0) && <section className={`health-banner ${healthBlocked ? "critical" : ""}`}><TriangleAlert /><div><strong>{healthName(health, language)}</strong><p>{dashboard?.connection.health_reason ?? (language === "ru" ? "Приложение продолжит работу автоматически после безопасной паузы." : "The app will resume automatically after a safe pause.")}</p></div>{(dashboard?.queue.failed ?? 0) > 0 && <button className="button secondary" onClick={() => void queueAction("retry-failed")}>{t.retryErrors} ({dashboard?.queue.failed})</button>}</section>}
      <section className="content-columns"><div><div className="section-heading"><p className="kicker">{t.rules} — {dashboard?.rules.length ?? 0}</p><span>{t.firstMatches}</span></div><div className="rule-table">{!dashboard?.rules.length ? <Empty icon={<Zap />} title={t.noRules} text={language === "ru" ? "Создайте правило и выберите, отвечать ли в комментарии, Direct или оба канала." : "Create a rule and choose comment replies, Direct, or both."} /> : dashboard.rules.map((item) => <RuleRow key={item.id} item={item} />)}</div></div>
        <div><div className="section-heading"><p className="kicker">{language === "ru" ? "Лента событий" : "Recent activity"}</p><button onClick={() => navigate("activity")}>{language === "ru" ? "Весь журнал" : "View all"}<ChevronRight /></button></div><div className="activity-feed">{!dashboard?.events.length ? <Empty icon={<Activity />} title={t.noEvents} /> : dashboard.events.slice(0, 6).map((event) => <EventRow key={event.id} event={event} compact />)}</div></div></section>
      {dashboard?.metaMode === "mock" && <section className="card mock-card"><div><p className="kicker">{t.mockTest}</p><strong>{language === "ru" ? "Проверьте правило без запросов к Meta" : "Test a rule without calling Meta"}</strong></div><input value={mockComment} onChange={(event) => setMockComment(event.target.value)} /><button className="button secondary" disabled={busy || !dashboard.rules.length} onClick={() => void simulate()}><CirclePlay />{t.runTest}</button></section>}
    </>;
  }

  function Metric({ icon, label, value, tone }: { icon: ReactNode; label: string; value: ReactNode; tone?: string }) { return <div className={`metric ${tone ?? ""}`}><span>{icon}{label}</span><strong>{value}</strong></div>; }

  function RuleRow({ item }: { item: Rule }) {
    const scoped = ruleStats.get(item.id);
    return <article className="rule-row"><button className="rule-description" onClick={() => openRule(item)}><span className="rule-name-line"><strong>{item.name}</strong><em><MessageCircle />{triggerName(item.trigger_type, language)}</em></span><span className="keyword-line">{item.match_mode === "any" ? t.any : item.keywords.map((word) => <code key={word}>{word}</code>)}<small>{item.direct_message_enabled ? (item.follow_gate_enabled ? (language === "ru" ? "материал после подписки" : "material after follow") : item.button_url ? (language === "ru" ? "материал по кнопке" : "button delivery") : t.direct) : t.commentReply}</small></span></button><div className="rule-funnel"><MetricTiny value={scoped?.triggered ?? null} label={plural(scoped?.triggered ?? 0, language, t.triggeredOne, t.triggeredFew, t.triggered)} /><MetricTiny value={scoped?.direct ?? null} label={t.direct} /><MetricTiny value={scoped?.opened ?? null} label={plural(scoped?.opened ?? 0, language, t.openedOne, t.openedFew, t.openedMany)} /></div><div className="rule-controls"><Toggle checked={item.active} onChange={(active) => void toggleRule(item, active)} label={t.active} /><button className="row-icon" onClick={() => openRule(item)} aria-label={t.edit}><Settings2 /></button><button className="row-icon danger" onClick={() => void removeRule(item)} aria-label={t.remove}><Trash2 /></button></div></article>;
  }

  function MetricTiny({ value, label }: { value: number | null; label: string }) { return <span><strong>{value ?? "—"}</strong><small>{label}</small></span>; }

  function EventRow({ event, compact = false }: { event: EventItem; compact?: boolean }) {
    const failed = ["failed", "dead_letter", "expired"].includes(event.status); const waiting = ["queued", "processing", "retry_wait", "uncertain"].includes(event.status);
    return <button className={`event-row ${failed ? "failed" : waiting ? "waiting" : ""}`} onClick={() => void openEvent(event)}><span className="event-status-icon">{failed ? <X /> : waiting ? <Clock3 /> : <Check />}</span><span className="event-copy"><strong>@{event.username ?? "unknown"}</strong><small>{event.rule_name ?? (language === "ru" ? "Удалённое правило" : "Deleted rule")} · {triggerName(event.trigger_type, language)}</small></span><time>{formatDate(event.created_at, language, compact)}</time><ChevronRight /></button>;
  }

  function ActivityView() {
    return <><PageTitle title={t.activityTitle} eyebrow={t.activity} subtitle={t.activitySubtitle} /><section className={`activity-layout ${selectedEvent ? "has-detail" : ""}`}><div className="card activity-list-card"><div className="activity-tools"><label><Search /><input placeholder={t.search} value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} /></label><div className="segmented" role="group" aria-label={t.activityTitle}><button type="button" aria-pressed={eventFilter === "all"} className={eventFilter === "all" ? "active" : ""} onClick={() => setEventFilter("all")}>{t.all}</button><button type="button" aria-pressed={eventFilter === "sent"} className={eventFilter === "sent" ? "active" : ""} onClick={() => setEventFilter("sent")}>{t.sent}</button><button type="button" aria-pressed={eventFilter === "failed"} className={eventFilter === "failed" ? "active" : ""} onClick={() => setEventFilter("failed")}>{t.failed}</button></div></div><div className="event-list">{filteredEvents.length ? filteredEvents.map((event) => <EventRow key={event.id} event={event} />) : <Empty icon={<Activity />} title={t.noEvents} />}</div></div><aside className={`card event-detail ${selectedEvent ? "open" : ""}`}>{selectedEvent ? <EventDetailView details={selectedEvent} /> : <Empty icon={<FileText />} title={t.eventDetails} text={language === "ru" ? "Выберите событие слева." : "Select an event on the left."} />}</aside></section></>;
  }

  function EventDetailView({ details }: { details: EventDetails }) {
    return <><div className="detail-head"><button className="mobile-detail-back" onClick={() => setSelectedEvent(null)}><ArrowLeft />{t.back}</button><div><span className={`status-pill ${details.event.status}`}>{statusName(details.event.status, language)}</span><h2>@{details.event.username ?? "unknown"}</h2><p>{details.event.rule_name ?? "—"} · {formatDate(details.event.created_at, language)}</p></div><button className="row-icon" onClick={() => setSelectedEvent(null)} aria-label="Close"><X /></button></div><div className="privacy-callout"><ShieldCheck /><span>{t.privacyNote}</span></div><div className="detail-timeline"><div className="timeline-item incoming"><span><Camera /></span><div><strong>{triggerName(details.event.trigger_type, language)}</strong><p>{language === "ru" ? "Получено и сопоставлено с правилом" : "Received and matched to a rule"}</p></div></div>{details.jobs.map((job) => <div className={`timeline-item ${job.status}`} key={job.id}><span>{job.kind === "public_reply" ? <MessageCircle /> : job.kind === "follow_check" ? <ShieldCheck /> : <Send />}</span><div><strong>{job.kind === "public_reply" ? t.commentReply : job.kind === "follow_check" ? (language === "ru" ? "Проверка подписки" : "Follow check") : job.kind === "follow_up" ? "Follow-up" : t.directMessage}</strong>{job.message && <p>{job.message}</p>}{job.button && <em><Link2 />{job.button.title}</em>}<small>{statusName(job.status, language)} · {t.attempts}: {job.attempts} · {formatDate(job.updated_at, language)}</small>{job.last_error && <div className="job-error"><TriangleAlert />{job.last_error}</div>}</div></div>)}</div>{details.link && <div className="link-result"><MousePointerClick /><div><strong>{details.link.first_clicked_at ? t.materialOpened : (language === "ru" ? "Ссылка доставлена" : "Link delivered")}</strong><p>{details.link.first_clicked_at ? formatDate(details.link.first_clicked_at, language) : formatDate(details.link.delivered_at, language)} · {language === "ru" ? "кликов" : "clicks"}: {details.link.click_count}</p></div></div>}{details.followGate && <div className="detail-meta"><span>{language === "ru" ? "Проверка подписки" : "Follow verification"}</span><strong>{details.followGate.status}</strong></div>}{details.followUp && <div className="detail-meta"><span>Follow-up</span><strong>{details.followUp.status}</strong></div>}</>;
  }

  function ConnectionView() {
    const workerRecent = dashboard?.connection.worker_heartbeat_at && Date.now() - new Date(dashboard.connection.worker_heartbeat_at).getTime() < 120_000;
    const checks = [{ label: t.token, ok: connected }, { label: t.subscription, ok: dashboard?.connection.subscription_healthy === true }, { label: t.recentWebhook, ok: Boolean(dashboard?.connection.last_webhook_at), optional: true }, { label: t.worker, ok: Boolean(workerRecent) }];
    return <><PageTitle title={t.connectTitle} eyebrow="INSTAGRAM API" subtitle={t.connectSubtitle} action={connected ? <span className="connection-chip"><span />@{dashboard?.connection.username}</span> : undefined} /><section className="connection-layout"><form className="card connection-form" onSubmit={saveMeta}><div className="section-heading"><div><p className="kicker">META FOR DEVELOPERS</p><h2>{language === "ru" ? "Данные приложения" : "Application credentials"}</h2></div><ShieldCheck /></div><label>{t.appId}<input value={metaConfig.appId} onChange={(event) => setMetaConfig({ ...metaConfig, appId: event.target.value })} placeholder="123456789012345" /></label><div className="form-two"><label>{t.appSecret}<input type="password" value={metaConfig.appSecret} onChange={(event) => setMetaConfig({ ...metaConfig, appSecret: event.target.value })} placeholder={dashboard?.connection.app_id ? "••••••••••••••••" : "Meta App Secret"} /></label><label>{t.graphVersion}<select value={metaConfig.graphVersion} onChange={(event) => setMetaConfig({ ...metaConfig, graphVersion: event.target.value })}><option>v25.0</option><option>v24.0</option></select></label></div><div className="endpoint-list"><Endpoint label={t.callback} value={dashboard?.urls.oauthCallback ?? ""} copyLabel={t.copyValue} /><Endpoint label={t.webhook} value={dashboard?.urls.webhook ?? ""} copyLabel={t.copyValue} /><Endpoint label={t.webhookToken} value={dashboard?.metaSetup.webhookVerifyToken ?? ""} copyLabel={t.copyValue} masked /><Endpoint label={t.deauthorizeUrl} value={dashboard?.urls.deauthorize ?? ""} copyLabel={t.copyValue} /><Endpoint label={t.dataDeletionUrl} value={dashboard?.urls.dataDeletion ?? ""} copyLabel={t.copyValue} /><Endpoint label={t.privacyUrl} value={dashboard?.urls.privacy ?? ""} copyLabel={t.copyValue} /></div><div className="form-actions"><button className="button primary" disabled={busy}>{t.saveConnect}</button>{dashboard?.connection.app_id && <button type="button" className="button secondary" onClick={() => void connectExisting()}>{t.repeatOauth}</button>}{connected && <button type="button" className="button text danger" onClick={() => void disconnect()}>{t.disconnect}</button>}</div></form>
        <aside className="card readiness-card"><div className="section-heading"><div><p className="kicker">{t.readiness}</p><h2>{healthName(health, language)}</h2></div><span className={`health-orb ${health}`}><Activity /></span></div><div className="check-list">{checks.map((item) => <div key={item.label}><span className={item.ok ? "ok" : item.optional ? "neutral" : "bad"}>{item.ok ? <Check /> : item.optional ? <Clock3 /> : <X />}</span><span>{item.label}<small>{item.ok ? t.ready : item.optional ? (language === "ru" ? "Появится после первого события" : "Appears after first event") : t.needsAttention}</small></span></div>)}</div>{dashboard?.connection.last_webhook_error && <div className="job-error"><TriangleAlert />{dashboard.connection.last_webhook_error}</div>}<button className="button secondary wide" disabled={busy || !connected} onClick={() => void healthCheck()}><RefreshCw />{t.check}</button></aside></section></>;
  }

  function Endpoint({ label, value, copyLabel, masked = false }: { label: string; value: string; copyLabel: string; masked?: boolean }) { return <div><span>{label}</span><code>{masked && value ? "••••••••••••••••" : value}</code><button type="button" aria-label={`${copyLabel}: ${label}`} onClick={() => void navigator.clipboard.writeText(value)}><Copy /></button></div>; }

  function RuleEditor() {
        return <><PageTitle title={editingId ? t.editRule : t.newRule} eyebrow={t.automations} action={<button className="button secondary" onClick={() => setScreen("automations")}><ArrowLeft />{t.back}</button>} /><form className="rule-editor-layout" onSubmit={saveRule}><div className="rule-editor-fields"><section className="card form-section"><div className="form-section-title"><span>01</span><div><h2>{language === "ru" ? "Основа правила" : "Rule basics"}</h2><p>{language === "ru" ? "Выберите событие и условия срабатывания." : "Choose the event and matching conditions."}</p></div></div><div className="form-two"><label>{t.ruleName}<input value={rule.name} onChange={(event) => setRule({ ...rule, name: event.target.value })} /></label><label>{t.priority}<input type="number" min={1} max={10000} value={rule.priority} onChange={(event) => setRule({ ...rule, priority: Number(event.target.value) })} /></label></div><div className="trigger-cards">{(["comment", "direct_message", "story_reply"] as TriggerType[]).map((value) => <button type="button" key={value} className={rule.triggerType === value ? "active" : ""} onClick={() => setRule({ ...rule, triggerType: value, targetScope: "all", publicReplyEnabled: value === "comment" ? rule.publicReplyEnabled : false, directMessageEnabled: value === "comment" ? rule.directMessageEnabled : true, followUpEnabled: value === "comment" && !rule.followGateEnabled ? false : rule.followUpEnabled })}>{value === "comment" ? <MessageCircle /> : value === "direct_message" ? <Send /> : <CirclePlay />}<span>{triggerName(value, language)}</span><Check /></button>)}</div><div className="form-two">{rule.triggerType === "comment" && <label>{t.publication}<select value={rule.targetScope} onChange={(event) => setRule({ ...rule, targetScope: event.target.value as RuleForm["targetScope"] })}><option value="all">{t.allMedia}</option><option value="specific">{t.specificMedia}</option></select></label>}<label>{t.match}<select value={rule.matchMode} onChange={(event) => setRule({ ...rule, matchMode: event.target.value as RuleForm["matchMode"] })}><option value="contains">{t.contains}</option><option value="exact">{t.exact}</option><option value="any">{t.any}</option></select></label></div>{rule.triggerType === "comment" && rule.targetScope === "specific" && <label>{t.publication}<select value={rule.mediaId} onChange={(event) => setRule({ ...rule, mediaId: event.target.value })}><option value="">{t.selectMedia}</option>{media.map((item) => <option key={item.id} value={item.id}>{`${item.mediaType === "VIDEO" ? "Reel" : "Post"} · ${(item.caption || item.id).slice(0, 80)}`}</option>)}</select></label>}{rule.matchMode !== "any" && <div className="field-group" role="group" aria-label={t.keywords}><strong>{t.keywords}</strong><small>{language === "ru" ? "Введите слово и нажмите Enter или запятую" : "Type a keyword and press Enter or comma"}</small><TagInput values={rule.keywords.split(",").map((value) => value.trim()).filter(Boolean)} onChange={(values) => setRule({ ...rule, keywords: values.join(", ") })} placeholder={language === "ru" ? "добавить…" : "add…"} label={t.keywords} /></div>}</section>
        {rule.triggerType === "comment" && <section className="card form-section"><div className="form-section-title"><span>02</span><div><h2>{language === "ru" ? "Действия" : "Actions"}</h2><p>{language === "ru" ? "Публичный ответ и Direct включаются независимо." : "Public reply and Direct can be enabled independently."}</p></div></div><SettingToggle title={t.commentReply} text={t.commentReplyHint} checked={rule.publicReplyEnabled} onChange={(checked) => setRule({ ...rule, publicReplyEnabled: checked })} />{rule.publicReplyEnabled && <div className="field-group" role="group" aria-label={t.variants}><strong>{t.variants}</strong><small>{language === "ru" ? "Добавляйте варианты отдельно — приложение выберет один из них." : "Add each option separately — the app will pick one."}</small><VariantEditor values={rule.publicReplies.split("\n")} onChange={(values) => setRule({ ...rule, publicReplies: values.join("\n") })} addLabel={language === "ru" ? "Добавить вариант" : "Add option"} removeLabel={language === "ru" ? "Удалить вариант" : "Remove option"} /></div>}<SettingToggle title={t.sendDirect} text={t.directHint} checked={rule.directMessageEnabled} onChange={(checked) => setRule({ ...rule, directMessageEnabled: checked, followGateEnabled: checked && rule.followGateEnabled, followUpEnabled: checked && rule.followUpEnabled })} /></section>}
        {directEnabled && <section className="card form-section"><div className="form-section-title"><span>{rule.triggerType === "comment" ? "03" : "02"}</span><div><h2>{t.directMessage}</h2><p>{language === "ru" ? "Сообщение, кнопка материала и необязательные условия." : "Message, material button, and optional conditions."}</p></div></div><SettingToggle title={t.followGate} text={language === "ru" ? "Пользователь добровольно нажимает кнопку, после чего Meta разрешает проверку." : "The user voluntarily taps a button before Meta allows the check."} checked={rule.followGateEnabled} onChange={(checked) => setRule({ ...rule, followGateEnabled: checked, followUpEnabled: !checked && rule.triggerType === "comment" ? false : rule.followUpEnabled })} />{rule.followGateEnabled && <><label>{t.firstDirect}<textarea rows={3} value={rule.followGatePrompt} onChange={(event) => setRule({ ...rule, followGatePrompt: event.target.value })} /></label><div className="form-two"><label>{t.checkButton}<input maxLength={20} value={rule.followGateButtonText} onChange={(event) => setRule({ ...rule, followGateButtonText: event.target.value })} /></label><label>{t.notFollowing}<textarea rows={3} value={rule.followGateRetryText} onChange={(event) => setRule({ ...rule, followGateRetryText: event.target.value })} /></label></div></>}<label>{rule.followGateEnabled ? t.finalMessage : t.directMessage}<textarea rows={4} value={rule.dmText} onChange={(event) => setRule({ ...rule, dmText: event.target.value })} /></label><div className="form-two"><label>{t.buttonText}<input value={rule.buttonText} onChange={(event) => setRule({ ...rule, buttonText: event.target.value })} /></label><label>{t.buttonUrl}<input type="url" value={rule.buttonUrl} onChange={(event) => setRule({ ...rule, buttonUrl: event.target.value })} /></label></div><SettingToggle title={t.followUp} text={rule.triggerType === "comment" && !rule.followGateEnabled ? (language === "ru" ? "Для комментария доступно после добровольной кнопки проверки подписки." : "For comment triggers, this is available after the voluntary follow-check button.") : (language === "ru" ? "Отменяется автоматически после клика." : "Cancelled automatically after the click.")} checked={rule.followUpEnabled} disabled={rule.triggerType === "comment" && !rule.followGateEnabled} onChange={(checked) => setRule({ ...rule, followUpEnabled: checked })} />{rule.followUpEnabled && <div className="form-two"><label>{t.delay}<input type="number" min={1} max={1320} value={rule.followUpDelayMinutes} onChange={(event) => setRule({ ...rule, followUpDelayMinutes: Number(event.target.value) })} /></label><label>{t.followUpText}<textarea rows={3} value={rule.followUpText} onChange={(event) => setRule({ ...rule, followUpText: event.target.value })} /></label></div>}</section>}
        <section className="card form-footer"><SettingToggle title={t.active} text={language === "ru" ? "Неактивное правило сохраняется, но не запускается." : "An inactive rule is saved but never triggered."} checked={rule.active} onChange={(checked) => setRule({ ...rule, active: checked })} /><div><button type="button" className="button secondary" onClick={() => setScreen("automations")}>{t.cancel}</button><button className="button primary" disabled={busy}>{busy ? `${t.save}…` : t.save}</button></div></section></div><aside className="preview-column"><InstagramPreview rule={rule} username={dashboard?.connection.username} language={language} t={t} directEnabled={directEnabled} /></aside></form></>;
  }

}
