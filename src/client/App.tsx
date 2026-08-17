import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

type Rule = {
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
};

type Dashboard = {
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
    health_state: "healthy" | "degraded" | "rate_limited" | "reauth_required" | "permission_required" | "restricted" | "misconfigured";
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
  events: Array<{
    id: string;
    username: string | null;
    status: string;
    error_message?: string | null;
    rule_name: string | null;
    media_id: string;
    trigger_type: "comment" | "direct_message" | "story_reply";
    created_at: string;
  }>;
  stats: { total_24h: number; sent_24h: number; failed_24h: number };
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

type MediaItem = { id: string; caption?: string; mediaType?: string; permalink?: string; timestamp?: string };

type FollowCheck = {
  eventId: string;
  username: string | null;
  available: boolean;
  isUserFollowBusiness?: boolean;
  reason?: string;
};

type RuleForm = {
  name: string;
  active: boolean;
  priority: number;
  triggerType: "comment" | "direct_message" | "story_reply";
  targetScope: "all" | "specific";
  mediaId: string;
  matchMode: "any" | "contains" | "exact";
  keywords: string;
  publicReplyEnabled: boolean;
  publicReplies: string;
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

const emptyRule: RuleForm = {
  name: "Гайд из комментариев",
  active: true,
  priority: 100,
  triggerType: "comment",
  targetScope: "all",
  mediaId: "",
  matchMode: "contains",
  keywords: "гайд",
  publicReplyEnabled: true,
  publicReplies: "Отправили информацию в Direct ✉️\nПроверьте Direct — всё уже там 🙌",
  dmText: "Спасибо за комментарий! Нажмите кнопку ниже, чтобы получить материал.",
  buttonText: "Получить гайд",
  buttonUrl: "https://example.com/guide",
  followGateEnabled: false,
  followGatePrompt: "Нажмите «Проверить подписку», чтобы получить материал.",
  followGateButtonText: "Проверить подписку",
  followGateRetryText: "Пока не вижу подписку. Подпишитесь на аккаунт и нажмите «Проверить подписку» ещё раз.",
  followUpEnabled: false,
  followUpDelayMinutes: 60,
  followUpText: "Не забудьте забрать материал — ссылка всё ещё доступна 👇",
};

function statusLabel(status: string) {
  return ({ sent: "Отправлено", queued: "В очереди", processing: "Отправляется", retry_wait: "Ожидает повтора", uncertain: "Проверяется", failed: "Ошибка", skipped_duplicate: "Повтор" } as Record<string, string>)[status] ?? status;
}

function triggerLabel(trigger: Rule["trigger_type"]) {
  return ({
    comment: "Комментарий Post/Reel",
    direct_message: "Входящий Direct",
    story_reply: "Ответ или реакция на Story",
  } as const)[trigger];
}

function healthLabel(state?: Dashboard["connection"]["health_state"]) {
  return ({
    healthy: "Подключение исправно", degraded: "Временная проблема", rate_limited: "Пауза Meta",
    reauth_required: "Нужно переподключить Instagram", permission_required: "Не хватает разрешений",
    restricted: "Аккаунт временно ограничен", misconfigured: "Ошибка конфигурации",
  } as Record<string, string>)[state ?? "healthy"];
}

function duration(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} сек.`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} мин.`;
  return `${Math.floor(seconds / 3600)} ч ${Math.ceil((seconds % 3600) / 60)} мин.`;
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("error") ?? "");
  const [busy, setBusy] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [showRule, setShowRule] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rule, setRule] = useState<RuleForm>(emptyRule);
  const [metaConfig, setMetaConfig] = useState({ appId: "", appSecret: "", graphVersion: "v25.0" });
  const [mockComment, setMockComment] = useState("гайд");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [followCheck, setFollowCheck] = useState<FollowCheck | null>(null);

  const connected = Boolean(dashboard?.connection.ig_user_id);
  const activeRules = useMemo(() => dashboard?.rules.filter((item) => item.active).length ?? 0, [dashboard]);
  const healthState = dashboard?.connection.health_state ?? "healthy";
  const healthBlocked = ["reauth_required", "permission_required", "restricted", "misconfigured"].includes(healthState);

  async function refresh() {
    const data = await api<Dashboard>("/api/dashboard");
    setDashboard(data);
    setMetaConfig((value) => ({ ...value, appId: data.connection.app_id ?? "", graphVersion: data.connection.graph_version ?? "v25.0" }));
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("error");
    if (oauthError || params.has("connected")) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    api<{ authenticated: boolean }>("/api/session")
      .then(async (session) => {
        setAuthenticated(session.authenticated);
        if (session.authenticated) await refresh();
      })
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [authenticated]);

  useEffect(() => {
    if (!showRule || !connected || media.length) return;
    api<MediaItem[]>("/api/meta/media").then(setMedia).catch(() => setError("Не удалось загрузить список публикаций Instagram."));
  }, [showRule, connected, media.length]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
      setAuthenticated(true);
      await refresh();
    } catch {
      setError("Неверный пароль или слишком много попыток.");
    } finally { setBusy(false); }
  }

  async function saveMeta(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("/api/meta/config", { method: "POST", body: JSON.stringify(metaConfig) });
      const { url } = await api<{ url: string }>("/api/meta/oauth-url");
      window.location.assign(url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Не удалось сохранить настройки Meta.");
      setBusy(false);
    }
  }

  async function connectExistingConfig() {
    setBusy(true); setError("");
    try {
      const { url } = await api<{ url: string }>("/api/meta/oauth-url");
      window.location.assign(url);
    } catch {
      setError("Сначала сохраните App ID и App Secret."); setBusy(false);
    }
  }

  async function disconnectInstagram() {
    if (!window.confirm("Отключить Instagram и удалить токен с этого сервера? Правила и журнал останутся.")) return;
    await api("/api/meta/connection", { method: "DELETE" });
    setShowConnection(false);
    await refresh();
  }

  async function queueAction(action: "pause" | "resume" | "retry-failed") {
    setBusy(true); setError("");
    try {
      await api(`/api/queue/${action}`, { method: "POST" });
      await refresh();
    } catch {
      setError("Не удалось изменить состояние очереди.");
    } finally { setBusy(false); }
  }

  async function checkConnectionHealth() {
    setBusy(true); setError("");
    try {
      await api("/api/meta/health-check", { method: "POST" });
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Проверка подключения не прошла.");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function checkFollowStatus(eventId: string) {
    setBusy(true); setError(""); setFollowCheck(null);
    try {
      const result = await api<Omit<FollowCheck, "eventId">>("/api/meta/follow-status", {
        method: "POST",
        body: JSON.stringify({ eventId }),
      });
      setFollowCheck({ eventId, ...result });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Не удалось проверить подписку.");
    } finally { setBusy(false); }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const payload = {
      ...rule,
      targetScope: rule.triggerType === "comment" ? rule.targetScope : "all",
      mediaId: rule.triggerType === "comment" && rule.targetScope === "specific" ? rule.mediaId : null,
      keywords: rule.matchMode === "any" ? [] : rule.keywords.split(",").map((word) => word.trim()).filter(Boolean),
      publicReplyEnabled: rule.triggerType === "comment" && rule.publicReplyEnabled,
      publicReplies: rule.triggerType === "comment" && rule.publicReplyEnabled ? rule.publicReplies.split("\n").map((text) => text.trim()).filter(Boolean).slice(0, 10) : [],
      buttonText: rule.buttonText || null,
      buttonUrl: rule.buttonUrl || null,
      followGatePrompt: rule.followGateEnabled ? rule.followGatePrompt : null,
      followGateButtonText: rule.followGateEnabled ? rule.followGateButtonText : null,
      followGateRetryText: rule.followGateEnabled ? rule.followGateRetryText : null,
      followUpText: rule.followUpEnabled ? rule.followUpText : null,
    };
    try {
      await api(editingId ? `/api/rules/${editingId}` : "/api/rules", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setShowRule(false); setEditingId(null); setRule(emptyRule);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? `Проверьте поля правила: ${caught.message}` : "Не удалось сохранить правило.");
    } finally { setBusy(false); }
  }

  function editRule(item: Rule) {
    setEditingId(item.id);
    setRule({
      name: item.name, active: item.active, priority: item.priority, triggerType: item.trigger_type, targetScope: item.target_scope,
      mediaId: item.media_id ?? "", matchMode: item.match_mode, keywords: item.keywords.join(", "),
      publicReplyEnabled: item.public_reply_enabled, publicReplies: item.public_replies.join("\n"),
      dmText: item.dm_text, buttonText: item.button_text ?? "", buttonUrl: item.button_url ?? "",
      followGateEnabled: item.follow_gate_enabled, followGatePrompt: item.follow_gate_prompt ?? emptyRule.followGatePrompt,
      followGateButtonText: item.follow_gate_button_text ?? emptyRule.followGateButtonText,
      followGateRetryText: item.follow_gate_retry_text ?? emptyRule.followGateRetryText,
      followUpEnabled: item.follow_up_enabled,
      followUpDelayMinutes: item.follow_up_delay_minutes,
      followUpText: item.follow_up_text ?? emptyRule.followUpText,
    });
    setShowRule(true);
  }

  async function removeRule(id: string) {
    if (!window.confirm("Удалить это правило? История отправок останется в журнале.")) return;
    await api(`/api/rules/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function simulate() {
    setBusy(true); setError("");
    try {
      const result = await api<{ result: string }>("/api/mock/comment", {
        method: "POST",
        body: JSON.stringify({ text: mockComment, mediaId: "demo-reel-1", username: `demo_${Date.now()}` }),
      });
      if (result.result === "no_match") setError("Ни одно активное правило не подошло к комментарию.");
      await new Promise((resolve) => window.setTimeout(resolve, 1600));
      await refresh();
    } finally { setBusy(false); }
  }

  if (authenticated === null) return <main className="center"><div className="loader" aria-label="Загрузка" /></main>;
  if (!authenticated) return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">C→D</div>
        <p className="eyebrow">SELF-HOSTED</p>
        <h1>Comment to DM</h1>
        <p className="muted">Автоматические ответы на комментарии Instagram — на вашем сервере и под вашим контролем.</p>
        <form onSubmit={login}>
          <label>Пароль администратора<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary full" disabled={busy}>{busy ? "Проверяем…" : "Войти"}</button>
        </form>
      </section>
    </main>
  );

  return (
    <div className="app-shell">
      <header>
        <div className="brand"><span className="brand-mark small">C→D</span><div><strong>Comment to DM</strong><span>Один аккаунт · ваш сервер</span></div></div>
        <div className="header-actions"><span className={`connection-dot ${connected ? "online" : ""}`} />{connected ? `@${dashboard?.connection.username ?? "Instagram"}` : "Не подключено"}<button className="ghost" onClick={() => void api("/api/logout", { method: "POST" }).then(() => setAuthenticated(false))}>Выйти</button></div>
      </header>

      <main className="content">
        {error && <div className="notice error-notice">{error}<button onClick={() => setError("")}>×</button></div>}
        <section className="hero-row">
          <div><p className="eyebrow">ПАНЕЛЬ УПРАВЛЕНИЯ</p><h1>Автоматизации</h1><p className="muted">Комментарии, входящие Direct и реакции на Stories → нужный сценарий в Direct.</p></div>
          <button className="primary" onClick={() => { setEditingId(null); setRule(emptyRule); setShowRule(true); }}>+ Создать правило</button>
        </section>

        <section className="stats">
          <article><span>За 24 часа</span><strong>{dashboard?.stats.total_24h ?? 0}</strong></article>
          <article><span>Отправлено</span><strong>{dashboard?.stats.sent_24h ?? 0}</strong></article>
          <article><span>Активных правил</span><strong>{activeRules}</strong></article>
          <article className={(dashboard?.stats.failed_24h ?? 0) > 0 ? "danger" : ""}><span>Ошибок</span><strong>{dashboard?.stats.failed_24h ?? 0}</strong></article>
        </section>

        <section className="connection-card">
          <div><span className={`connection-dot ${connected ? "online" : ""}`} /><div><strong>{connected ? `Instagram подключён: @${dashboard?.connection.username ?? "account"}` : "Подключите Instagram"}</strong><p>{connected ? "Webhook и очередь готовы принимать комментарии и сообщения." : "Нужны App ID и App Secret вашего Meta-приложения."}</p></div></div>
          <button className="secondary" onClick={() => connected ? setShowConnection(true) : setShowConnection(!showConnection)}>{connected ? "Настройки" : "Подключить"}</button>
        </section>

        <section className="panel queue-panel">
          <div className="panel-title">
            <div><h2>Очередь доставки</h2><p>Direct отправляется первым. При ограничениях Meta очередь остановится автоматически и ничего не потеряет.</p></div>
            <span className={`queue-state ${dashboard?.connection.outbound_paused || healthBlocked ? "paused" : healthState !== "healthy" || dashboard?.connection.rate_limited_until && new Date(dashboard.connection.rate_limited_until) > new Date() ? "limited" : "ready"}`}>
              {dashboard?.connection.outbound_paused
                ? "Пауза"
                : healthState !== "healthy" ? healthLabel(healthState)
                  : dashboard?.connection.rate_limited_until && new Date(dashboard.connection.rate_limited_until) > new Date()
                    ? "Пауза Meta"
                  : (dashboard?.queue.pending ?? 0) > 0 ? "Отправляется" : "Готова"}
            </span>
          </div>
          <div className="queue-grid">
            <div><span>Всего в очереди</span><strong>{dashboard?.queue.pending ?? 0}</strong></div>
            <div><span>Direct</span><strong>{dashboard?.queue.private_pending ?? 0}</strong></div>
            <div><span>Публичные ответы</span><strong>{dashboard?.queue.public_pending ?? 0}</strong></div>
            <div><span>Скорость API</span><strong>{(dashboard?.queue.throughput_per_minute ?? 0).toFixed(1)} / мин</strong></div>
          </div>
          {(dashboard?.queue.pending ?? 0) > 0 && <div className="queue-details">
            <span>Самое старое задание: {duration(dashboard?.queue.oldest_seconds ?? 0)}</span>
            <span>Оценка завершения: {(dashboard?.queue.throughput_per_minute ?? 0) > 0 ? duration(((dashboard?.queue.pending ?? 0) / dashboard!.queue.throughput_per_minute) * 60) : "собираем данные"}</span>
            {(dashboard?.queue.retrying ?? 0) > 0 && <span>Ожидают повтора: {dashboard?.queue.retrying}</span>}
            {(dashboard?.queue.uncertain ?? 0) > 0 && <span>Проверяем результат: {dashboard?.queue.uncertain}</span>}
          </div>}
          {healthState !== "healthy" && <div className={`queue-warning ${healthBlocked ? "critical" : ""}`}>
            <strong>{healthLabel(healthState)}</strong>
            <span>{dashboard?.connection.health_reason ?? "Приложение выполнит безопасную повторную проверку автоматически."}</span>
          </div>}
          {dashboard?.connection.surge_mode && <div className="queue-warning surge">
            Режим всплеска: временно отправляем только Direct, чтобы не приблизиться к семидневному дедлайну.
          </div>}
          {dashboard?.connection.rate_limited_until && new Date(dashboard.connection.rate_limited_until) > new Date() && <div className="queue-warning">
            Meta временно ограничила скорость. Продолжим после {new Date(dashboard.connection.rate_limited_until).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.
          </div>}
          <div className="queue-actions">
            <button className="secondary" disabled={busy} onClick={() => void queueAction(dashboard?.connection.outbound_paused ? "resume" : "pause")}>
              {dashboard?.connection.outbound_paused ? "Продолжить отправку" : "Поставить на паузу"}
            </button>
            {(dashboard?.queue.failed ?? 0) > 0 && <button className="ghost" disabled={busy} onClick={() => void queueAction("retry-failed")}>Повторить ошибки ({dashboard?.queue.failed})</button>}
            {connected && <button className="ghost" disabled={busy} onClick={() => void checkConnectionHealth()}>Проверить подключение</button>}
            {healthState === "reauth_required" && <button className="ghost" disabled={busy} onClick={() => setShowConnection(true)}>Переподключить</button>}
            {dashboard?.connection.last_meta_usage_percent != null && <span className="meta-usage">Нагрузка Meta: {dashboard.connection.last_meta_usage_percent}%</span>}
          </div>
        </section>

        {showConnection && <section className="panel form-panel">
          <div className="panel-title"><div><h2>Подключение Meta</h2><p>Ключи сохраняются зашифрованными только на этом сервере.</p></div><button className="icon-button" onClick={() => setShowConnection(false)}>×</button></div>
          <form onSubmit={saveMeta} className="grid-form">
            <label>App ID<input value={metaConfig.appId} onChange={(event) => setMetaConfig({ ...metaConfig, appId: event.target.value })} placeholder="123456789012345" /></label>
            <label>App Secret<input type="password" value={metaConfig.appSecret} onChange={(event) => setMetaConfig({ ...metaConfig, appSecret: event.target.value })} placeholder={dashboard?.connection.app_id ? "Введите заново, чтобы изменить" : "Meta App Secret"} /></label>
            <label>Graph API<select value={metaConfig.graphVersion} onChange={(event) => setMetaConfig({ ...metaConfig, graphVersion: event.target.value })}><option>v25.0</option><option>v24.0</option></select></label>
            <div className="url-list"><span>OAuth callback</span><code>{dashboard?.urls.oauthCallback}</code><span>Webhook</span><code>{dashboard?.urls.webhook}</code></div>
            <div className="form-actions"><button className="primary" disabled={busy}>Сохранить и подключить</button>{dashboard?.connection.app_id && <button type="button" className="secondary" onClick={connectExistingConfig}>Повторить OAuth</button>}{connected && <button type="button" className="ghost danger-text" onClick={() => void disconnectInstagram()}>Отключить Instagram</button>}</div>
          </form>
        </section>}

        <section className="panel">
          <div className="panel-title"><div><h2>Правила</h2><p>Сработает первое подходящее правило с меньшим приоритетом.</p></div></div>
          {!dashboard?.rules.length ? <div className="empty"><strong>Правил пока нет</strong><p>Создайте первое правило для слова «гайд».</p></div> : <div className="rule-list">
            {dashboard.rules.map((item) => <article className="rule-card" key={item.id}>
              <div className={`rule-icon ${item.active ? "active" : ""}`}>{item.active ? "ON" : "OFF"}</div>
              <div className="rule-main"><div><strong>{item.name}</strong><span className="pill">{triggerLabel(item.trigger_type)}</span>{item.trigger_type === "comment" && <span className="pill">{item.target_scope === "all" ? "Все Post/Reel" : item.media_id}</span>}{item.follow_gate_enabled && <span className="pill">Проверка подписки</span>}{item.follow_up_enabled && <span className="pill">Follow-up через {duration(item.follow_up_delay_minutes * 60)}</span>}</div><p>{item.match_mode === "any" ? item.trigger_type === "comment" ? "Любой комментарий" : "Любое сообщение или реакция" : `Ключи: ${item.keywords.join(", ")}`}</p><small>{item.follow_gate_enabled ? "После подписки" : "Direct"}: {item.dm_text}</small></div>
              <div className="row-actions"><button className="ghost" onClick={() => editRule(item)}>Изменить</button><button className="ghost danger-text" onClick={() => void removeRule(item.id)}>Удалить</button></div>
            </article>)}
          </div>}
        </section>

        {dashboard?.metaMode === "mock" && <section className="panel test-panel"><div><h2>Тестовый комментарий</h2><p>Проверяет правила и очередь без запросов в Instagram.</p></div><input value={mockComment} onChange={(event) => setMockComment(event.target.value)} /><button className="secondary" disabled={busy || !dashboard.rules.length} onClick={() => void simulate()}>Запустить тест</button></section>}

        <section className="panel">
          <div className="panel-title"><div><h2>Последние события</h2><p>Журнал хранится 30 дней. Тексты комментариев и входящих сообщений не сохраняются.</p></div></div>
          {!dashboard?.events.length ? <div className="empty compact">Здесь появятся отправки и ошибки.</div> : <div className="events">
            {dashboard.events.map((event) => <div className="event" key={event.id}>
              <span className={`status ${event.status}`}>{statusLabel(event.status)}</span>
              <strong>@{event.username ?? "unknown"}</strong>
              <span>{triggerLabel(event.trigger_type)} · {event.rule_name ?? "Удалённое правило"}</span>
              <time>{new Date(event.created_at).toLocaleString("ru-RU")}</time>
              <button className="ghost follow-check-button" disabled={busy || !connected} onClick={() => void checkFollowStatus(event.id)}>Проверить подписку</button>
              {followCheck?.eventId === event.id && <small className={`follow-result ${followCheck.available && followCheck.isUserFollowBusiness ? "following" : "not-following"}`}>
                {followCheck.available
                  ? followCheck.isUserFollowBusiness ? "Подписка подтверждена" : "Пользователь не подписан"
                  : `Meta не разрешила проверку: ${followCheck.reason ?? "нет согласия на доступ к профилю"}`}
              </small>}
            </div>)}
          </div>}
        </section>
      </main>

      {showRule && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="rule-title">
        <div className="panel-title"><div><p className="eyebrow">АВТОМАТИЗАЦИЯ</p><h2 id="rule-title">{editingId ? "Изменить правило" : "Новое правило"}</h2></div><button className="icon-button" onClick={() => setShowRule(false)}>×</button></div>
        <form onSubmit={saveRule} className="rule-form">
          <label>Название<input value={rule.name} onChange={(event) => setRule({ ...rule, name: event.target.value })} /></label>
          <label>Что запускает правило<select value={rule.triggerType} onChange={(event) => {
            const triggerType = event.target.value as RuleForm["triggerType"];
            setRule({ ...rule, triggerType, targetScope: "all", publicReplyEnabled: triggerType === "comment" ? rule.publicReplyEnabled : false, followUpEnabled: triggerType === "comment" && !rule.followGateEnabled ? false : rule.followUpEnabled });
          }}><option value="comment">Комментарий под Post или Reel</option><option value="direct_message">Входящее сообщение в Direct</option><option value="story_reply">Ответ или реакция на Story</option></select></label>
          <div className="two-cols">{rule.triggerType === "comment" && <label>Публикации<select value={rule.targetScope} onChange={(event) => setRule({ ...rule, targetScope: event.target.value as RuleForm["targetScope"] })}><option value="all">Все Post и Reel</option><option value="specific">Конкретный Post/Reel</option></select></label>}<label>Совпадение<select value={rule.matchMode} onChange={(event) => setRule({ ...rule, matchMode: event.target.value as RuleForm["matchMode"] })}><option value="contains">Содержит слово</option><option value="exact">Точное совпадение</option><option value="any">{rule.triggerType === "comment" ? "Любой комментарий" : rule.triggerType === "story_reply" ? "Любой ответ или реакция" : "Любое сообщение"}</option></select></label></div>
          {rule.triggerType === "comment" && rule.targetScope === "specific" && <label>Post или Reel<select value={rule.mediaId} onChange={(event) => setRule({ ...rule, mediaId: event.target.value })}><option value="">Выберите публикацию</option>{media.map((item) => <option value={item.id} key={item.id}>{`${item.mediaType === "VIDEO" ? "Reel" : "Post"} · ${(item.caption || "Без подписи").slice(0, 70)}`}</option>)}</select>{!connected && <span>Сначала подключите Instagram.</span>}</label>}
          {rule.matchMode !== "any" && <label>Ключевые слова <span>через запятую</span><input value={rule.keywords} onChange={(event) => setRule({ ...rule, keywords: event.target.value })} /></label>}
          {rule.triggerType === "comment" && <label className="check"><input type="checkbox" checked={rule.publicReplyEnabled} onChange={(event) => setRule({ ...rule, publicReplyEnabled: event.target.checked })} />Публично ответить под комментарием</label>}
          {rule.triggerType === "comment" && rule.publicReplyEnabled && <label>Варианты публичного ответа <span>каждый с новой строки, максимум 10</span><textarea rows={5} value={rule.publicReplies} onChange={(event) => setRule({ ...rule, publicReplies: event.target.value })} /></label>}
          <label className="check"><input type="checkbox" checked={rule.followGateEnabled} onChange={(event) => setRule({ ...rule, followGateEnabled: event.target.checked, followUpEnabled: !event.target.checked && rule.triggerType === "comment" ? false : rule.followUpEnabled })} />Выдать материал только после проверки подписки</label>
          {rule.followGateEnabled && <>
            <label>Первое сообщение в Direct<textarea rows={3} value={rule.followGatePrompt} onChange={(event) => setRule({ ...rule, followGatePrompt: event.target.value })} /></label>
            <label>Текст кнопки проверки <span>до 20 символов</span><input maxLength={20} value={rule.followGateButtonText} onChange={(event) => setRule({ ...rule, followGateButtonText: event.target.value })} /></label>
            <label>Если пользователь ещё не подписан<textarea rows={3} value={rule.followGateRetryText} onChange={(event) => setRule({ ...rule, followGateRetryText: event.target.value })} /></label>
          </>}
          <label>{rule.followGateEnabled ? "Сообщение после подтверждения подписки" : "Сообщение в Direct"}<textarea rows={4} value={rule.dmText} onChange={(event) => setRule({ ...rule, dmText: event.target.value })} /></label>
          <div className="two-cols"><label>Текст кнопки материала<input value={rule.buttonText} onChange={(event) => setRule({ ...rule, buttonText: event.target.value })} /></label><label>HTTPS-ссылка на материал<input type="url" value={rule.buttonUrl} onChange={(event) => setRule({ ...rule, buttonUrl: event.target.value })} /></label></div>
          <label className="check"><input type="checkbox" checked={rule.followUpEnabled} disabled={rule.triggerType === "comment" && !rule.followGateEnabled} onChange={(event) => setRule({ ...rule, followUpEnabled: event.target.checked })} />Напомнить, если пользователь не открыл материал</label>
          {rule.triggerType === "comment" && !rule.followGateEnabled && <p className="muted">Для комментария follow-up доступен вместе с проверкой подписки: нажатие postback-кнопки открывает разрешённое Meta окно сообщений.</p>}
          {rule.followUpEnabled && <><label>Через сколько минут <span>не более 22 часов</span><input type="number" min={1} max={1320} value={rule.followUpDelayMinutes} onChange={(event) => setRule({ ...rule, followUpDelayMinutes: Number(event.target.value) })} /></label><label>Текст напоминания<textarea rows={3} value={rule.followUpText} onChange={(event) => setRule({ ...rule, followUpText: event.target.value })} /></label><p className="muted">Ссылка будет отслеживаться только вашим сервером. Если материал уже открыт, напоминание автоматически отменится.</p></>}
          <label className="check"><input type="checkbox" checked={rule.active} onChange={(event) => setRule({ ...rule, active: event.target.checked })} />Правило активно</label>
          <div className="form-actions end"><button type="button" className="secondary" onClick={() => setShowRule(false)}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить правило"}</button></div>
        </form>
      </section></div>}
    </div>
  );
}
