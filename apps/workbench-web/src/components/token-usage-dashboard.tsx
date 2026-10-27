import { useIntl } from "@opencraft/i18n/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { SegmentedControl, SettingsButton, SettingsNotice, SettingsPageHeader, SettingsSection, SettingsSelect, SettingsTextInput } from "@opencraft/extension-react";
import { TOKEN_USAGE_CONFIGURE, TOKEN_USAGE_QUERY, type TokenUsageSnapshot, type TokenUsageTurnDetail } from "@opencraft/appserver-protocol/token-usage";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { useWorkbenchPresentationActive } from "./workbench-presentation-activity";
import {
  type ActivityCell,
  compactTokens,
  dashboardMetrics,
  buildActivityGrid,
  buildActivityBars,
  modelShare,
  formatModelLabel,
  formatStateLabel,
} from "./token-usage-dashboard-data";
import "./token-usage-dashboard.scss";

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
}
function before(days: number) {
  const date = new Date(today() + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}
function formatCount(value: string, locale: string) {
  try {
    return new Intl.NumberFormat(locale).format(BigInt(value));
  } catch {
    return value;
  }
}
function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : null;
}

export default function TokenUsageDashboard({ hostId }: { hostId: string }) {
  const intl = useIntl();
  const { agentRuntimes, threadAttention } = useAppServerHosts();
  const readScope = useCallback(() => threadAttention.getScope() ?? "anonymous", [threadAttention]);
  const accountScope = useSyncExternalStore(threadAttention.subscribe, readScope, readScope);
  return <TokenUsageDashboardView key={JSON.stringify([hostId, accountScope])} hostId={hostId} agentRuntimes={agentRuntimes} locale={intl.locale} />;
}

export function TokenUsageDashboardView({
  hostId,
  agentRuntimes,
  locale = "zh-CN",
}: {
  hostId: string;
  agentRuntimes: ReturnType<typeof useAppServerHosts>["agentRuntimes"];
  locale?: string;
}) {
  const zh = locale.toLowerCase().startsWith("zh");
  const copy = (cn: string, en: string) => (zh ? cn : en);
  const count = (value: string) => formatCount(value, locale);
  const modelLabel = (key: string) => formatModelLabel(key, copy);
  const stateLabel = (state: string) => formatStateLabel(state, copy);
  const active = useWorkbenchPresentationActive();
  const subscribe = useCallback((listener: () => void) => agentRuntimes.subscribe(hostId, listener), [agentRuntimes, hostId]);
  const read = useCallback(() => agentRuntimes.getSnapshot(hostId).phase, [agentRuntimes, hostId]);
  const connection = useSyncExternalStore(subscribe, read, read);

  const [range, setRange] = useState("7");
  const [from, setFrom] = useState(() => before(7));
  const [through, setThrough] = useState(today);
  const [scope, setScope] = useState("self");
  const [actorId, setActor] = useState("");
  const [actorName, setActorName] = useState("");
  const [modelKey, setModel] = useState("");
  const [view, setView] = useState("threads");
  const [threadId, setThread] = useState("");
  const [snapshot, setSnapshot] = useState<TokenUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const [activityMode, setActivityMode] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [previewCell, setPreviewCell] = useState<ActivityCell | null>(null);
  const [selectedCell, setSelectedCell] = useState<ActivityCell | null>(null);
  const activeCell = previewCell ?? selectedCell;

  const generation = useRef(0);
  const revision = useRef(-1);
  const inFlight = useRef(false);
  const page = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();
  const pendingScroll = useRef<{ top: number; focusThread?: string } | null>(null);
  const summaryReturn = useRef<{ top: number; cursor: string | null; thread: string } | null>(null);
  const viewport = () => page.current?.closest<HTMLElement>(".settings-page__viewport") ?? null;

  const requestKey = JSON.stringify([hostId, from, through, scope, actorId, modelKey, view, threadId, connection]);
  const latestKey = useRef(requestKey);
  latestKey.current = requestKey;
  const [displayKey, setDisplayKey] = useState(requestKey);
  const visible = snapshot && displayKey === requestKey ? snapshot : null;

  useEffect(() => {
    const epoch = ++generation.current;
    revision.current = -1;
    setPreviewCell(null);
    setSelectedCell(null);
    setSnapshot(null);
    setError(null);
    setDisplayKey(requestKey);
    inFlight.current = false;
    return () => {
      if (generation.current === epoch) generation.current++;
    };
  }, [requestKey]);

  useEffect(() => {
    if (!active) return;
    const epoch = generation.current;
    const key = requestKey;
    let live = true;
    const load = async () => {
      if (!live || inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      try {
        const result = await agentRuntimes.request(hostId, TOKEN_USAGE_QUERY, {
          from,
          through,
          scope,
          ...(scope === "team" && actorId ? { actorId } : {}),
          ...(modelKey ? { modelKey } : {}),
          view: threadId ? "turns" : view,
          ...(threadId ? { threadId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 50,
        });
        if (!live || epoch !== generation.current || latestKey.current !== key) return;
        if (result.snapshotRevision < revision.current) return;
        revision.current = result.snapshotRevision;
        setSnapshot(result);
        setDisplayKey(key);
        setError(null);
      } catch (cause) {
        if (!live || epoch !== generation.current || latestKey.current !== key) return;
        const code = errorCode(cause);
        if (code === 401 || code === 403) {
          setSnapshot(null);
          setError(code === 401 ? copy("请登录后查看用量。", "Sign in to view usage.") : copy("当前身份无权查看此范围。", "You cannot view this usage scope."));
        } else if (code === 409) {
          setCursor(null);
          setRefresh((n) => n + 1);
          setError(copy("数据已更新，正在重取第一页。", "Usage changed. Reloading the first page."));
        } else if (code === -32601) {
          setSnapshot(null);
          setError(copy("此执行服务暂不支持 Token 统计。", "This Host does not support token statistics."));
        } else {
          setError(copy("刷新失败。显示的数据可能已过期，请重试。", "Refresh failed. Displayed usage may be stale. Try again."));
        }
      } finally {
        if (live && epoch === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    };
    void load();
    const timer = cursor ? null : setInterval(() => void load(), 5000);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      inFlight.current = false;
    };
  }, [agentRuntimes, requestKey, hostId, from, through, scope, actorId, modelKey, view, threadId, cursor, refresh, active]);

  const configure = async (enabled: boolean) => {
    if (loading) return;
    const epoch = generation.current;
    const key = latestKey.current;
    const current = () => epoch === generation.current && key === latestKey.current;
    setLoading(true);
    try {
      await agentRuntimes.request(hostId, TOKEN_USAGE_CONFIGURE, { enabled });
      if (!current()) return;
      setCursor(null);
      setRefresh((n) => n + 1);
    } catch {
      if (current()) setError(copy("计量设置未能保存，请重试。", "Could not save collection settings. Try again."));
    } finally {
      if (current()) setLoading(false);
    }
  };

  useLayoutEffect(() => {
    if (reservedHeight !== undefined && pendingScroll.current) {
      const owner = viewport();
      if (owner) owner.scrollTop = pendingScroll.current.top;
    }
  }, [requestKey, reservedHeight]);

  useLayoutEffect(() => {
    if (!visible || loading || !pendingScroll.current) return;
    if (reservedHeight !== undefined) {
      setReservedHeight(undefined);
      return;
    }
    const position = pendingScroll.current;
    pendingScroll.current = null;
    const owner = viewport();
    if (owner) owner.scrollTop = position.top;
    if (position.focusThread) {
      const trigger = Array.from(page.current?.querySelectorAll<HTMLButtonElement>("button[data-usage-thread]") ?? []).find(
        (button) => button.dataset.usageThread === position.focusThread,
      );
      trigger?.focus({ preventScroll: true });
    }
  }, [visible, loading, reservedHeight]);

  const change = (action: () => void, nextCursor: string | null = null) => {
    generation.current++;
    inFlight.current = false;
    setReservedHeight(page.current?.getBoundingClientRect().height);
    pendingScroll.current = { top: viewport()?.scrollTop ?? 0 };
    setLoading(true);
    action();
    setCursor(nextCursor);
  };

  const selectRange = (value: string) => {
    setRange(value);
    if (value === "7" || value === "30") {
      change(() => {
        setFrom(before(Number(value)));
        setThrough(today());
      });
    }
  };

  const openThread = (id: string) => {
    summaryReturn.current = { top: viewport()?.scrollTop ?? 0, cursor, thread: id };
    change(() => setThread(id));
  };
  const returnToSummary = () => {
    const saved = summaryReturn.current;
    change(() => setThread(""), saved?.cursor ?? null);
    if (saved) pendingScroll.current = { top: saved.top, focusThread: saved.thread };
  };
  const choosePerson = (id: string, name: string) =>
    change(() => {
      setActor(id);
      setActorName(name);
      setView("threads");
      setThread("");
    });
  const browsePeople = () =>
    change(() => {
      setActor("");
      setActorName("");
      setView("actors");
      setThread("");
    });

  const modelOptions = visible?.models ?? [];
  const details = visible?.view === "turns" ? (visible.rows as TokenUsageTurnDetail[]) : null;

  const metrics = visible ? dashboardMetrics(visible) : null;
  const grid = visible ? buildActivityGrid(visible.daily, from, through, locale) : null;
  const bars = visible ? buildActivityBars(visible.daily, from, through, activityMode === "cumulative" ? "cumulative" : "weekly", locale) : [];

  const summaryTitle =
    scope === "self"
      ? copy("我的分摊用量", "My allocated usage")
      : actorId
      ? copy(`${actorName} 的分摊用量`, `${actorName}’s allocated usage`)
      : copy("团队用量", "Team usage");

  const detailTitle = threadId
    ? copy("会话的轮次明细", "Conversation turn details")
    : view === "threads"
    ? copy("会话汇总", "Conversations")
    : view === "actors"
    ? copy("人员汇总", "People")
    : copy("轮次明细", "Turn details");

  const lastSource = visible?.coverage?.lastSourceSuccessAt ?? visible?.diagnostics?.lastSourceSuccessAt ?? null;

  return (
    <div ref={page} className="token-usage__page" aria-busy={loading} style={{ minHeight: reservedHeight }}>
      <SettingsPageHeader
        title={copy("Token 用量", "Token usage")}
        description={copy("按轮次参与人均分 · 按轮次开始日统计 · Asia/Shanghai", "Shared equally by turn participants \u00b7 Grouped by turn start date \u00b7 Asia/Shanghai")}
      />

      {/* Single-line Toolbar */}
      <div className="token-usage__toolbar" role="group" aria-label={copy("用量筛选", "Usage filters")}>
        <label className="token-usage__field">
          <span>{copy("用量范围", "Scope")}</span>
          <SettingsSelect
            value={scope}
            onChange={(e) =>
              change(() => {
                setScope(e.target.value);
                setActor("");
                setActorName("");
              })
            }
          >
            <option value="self">{copy("我的用量", "My usage")}</option>
            {visible?.canQueryTeam || scope === "team" ? <option value="team">{copy("团队用量", "Team usage")}</option> : null}
          </SettingsSelect>
        </label>

        <label className="token-usage__field">
          <span>{copy("时间范围", "Range")}</span>
          <SettingsSelect value={range} onChange={(e) => selectRange(e.target.value)}>
            <option value="7">{copy("近 7 日", "Last 7 days")}</option>
            <option value="30">{copy("近 30 日", "Last 30 days")}</option>
            <option value="custom">{copy("自定义", "Custom")}</option>
          </SettingsSelect>
        </label>

        {range === "custom" ? (
          <>
            <label className="token-usage__field">
              <span>{copy("开始日", "From")}</span>
              <SettingsTextInput
                type="date"
                value={from}
                max={through}
                onChange={(e) => {
                  setRange("custom");
                  change(() => setFrom(e.target.value));
                }}
              />
            </label>
            <label className="token-usage__field">
              <span>{copy("结束日", "Through")}</span>
              <SettingsTextInput
                type="date"
                value={through}
                min={from}
                onChange={(e) => {
                  setRange("custom");
                  change(() => setThrough(e.target.value));
                }}
              />
            </label>
          </>
        ) : null}

        <label className="token-usage__field">
          <span>{copy("模型", "Model")}</span>
          <SettingsSelect value={modelKey} onChange={(e) => change(() => setModel(e.target.value))}>
            <option value="">{copy("全部模型", "All models")}</option>
            {modelOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {modelLabel(m.key)}
              </option>
            ))}
            {modelKey && !modelOptions.some((m) => m.key === modelKey) ? <option value={modelKey}>{modelLabel(modelKey)}</option> : null}
          </SettingsSelect>
        </label>

        <SettingsButton
          disabled={loading}
          onClick={() => {
            setCursor(null);
            setRefresh((n) => n + 1);
          }}
        >
          {copy("刷新", "Refresh")}
        </SettingsButton>
      </div>

      {error ? <SettingsNotice role="alert">{error}</SettingsNotice> : null}
      {loading && !visible ? <p role="status">{copy("正在读取用量…", "Loading usage\u2026")}</p> : null}

      {visible && metrics ? (
        <>
          {/* Key Metrics Strip (5 cells) */}
          <section className="token-usage__summary" aria-labelledby="token-usage-summary-title">
            <div className="token-usage__summary-head">
              <div>
                <h2 id="token-usage-summary-title">{summaryTitle}</h2>
                <p>{copy("按轮次参与人均分 · 按轮次开始日统计 · Asia/Shanghai", "Shared equally by turn participants \u00b7 Grouped by turn start date \u00b7 Asia/Shanghai")}</p>
              </div>
              {visible.coverage.partial ? <span className="token-usage__badge">{copy("部分数据", "Partial data")}</span> : null}
            </div>

            <div className="token-usage__strip" role="group" aria-label={copy("核心指标", "Key metrics")}>
              <div className="token-usage__strip-cell">
                <strong title={count(metrics.settled)}>{compactTokens(metrics.settled, locale)}</strong>
                <span>{copy("已结算 Token", "Settled tokens")}</span>
                <small title={count(metrics.total)}>{copy(`所选范围总量 ${count(metrics.total)}`, `Total in range ${count(metrics.total)}`)}</small>
              </div>
              <div className="token-usage__strip-cell">
                <strong title={count(metrics.peak)}>{compactTokens(metrics.peak, locale)}</strong>
                <span>{copy("单日峰值", "Peak tokens")}</span>
                <small>{metrics.peakDay ?? "—"}</small>
              </div>
              <div className="token-usage__strip-cell">
                <strong>{metrics.settledTurns === null ? "—" : count(String(metrics.settledTurns))}</strong>
                <span>{copy("已结算轮次", "Settled turns")}</span>
                <small>{copy(`共 ${visible.summary.turns} 轮`, `${visible.summary.turns} turns total`)}</small>
              </div>
              <div className="token-usage__strip-cell">
                <strong>{metrics.longestStreak}</strong>
                <span>{copy("最长连续活跃天数", "Longest streak")}</span>
                <small>{copy("天", "days")}</small>
              </div>
              <div className="token-usage__strip-cell">
                <strong>{metrics.currentStreak}</strong>
                <span>{copy("当前连续活跃天数", "Current streak")}</span>
                <small>{copy("天", "days")}</small>
              </div>
            </div>

            <p className="token-usage__summary-meta">
              {copy(`${visible.summary.threads ?? "—"} 个会话 · ${visible.summary.turns} 个轮次`, `${visible.summary.threads ?? "—"} conversations · ${visible.summary.turns} turns`)}
            </p>
          </section>

          {/* Token Activity Heatmap / Trend */}
          <section className="token-usage__activity" aria-labelledby="token-usage-activity-title">
            <div className="token-usage__activity-head">
              <div>
                <h3 id="token-usage-activity-title">{copy("Token 活跃度", "Token activity")}</h3>
                <p>{copy("按轮次开始日统计", "Grouped by turn start date")}</p>
              </div>
              <SegmentedControl
                label={copy("活跃度视图", "Activity view")}
                value={activityMode}
                onValueChange={(val) => setActivityMode(val as typeof activityMode)}
                options={[
                  { value: "daily", label: copy("按日", "Daily") },
                  { value: "weekly", label: copy("按周", "Weekly") },
                  { value: "cumulative", label: copy("累计", "Cumulative") },
                ]}
              />
            </div>

            {activityMode === "daily" && grid ? (
              <>
                <div className="token-usage__heatmap-wrap">
                  <div className="token-usage__heatmap-days" aria-hidden="true">
                    {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
                      <span key={d} data-row={i}>
                        {i % 2 === 0 ? (zh ? d : ["Mon", "", "Wed", "", "Fri", "", "Sun"][i]) : ""}
                      </span>
                    ))}
                  </div>
                  <div
                    className="token-usage__heatmap"
                    role="group"
                    aria-label={copy("每日 Token 活跃度热力图", "Daily token activity heatmap")}
                    style={{ gridTemplateColumns: `repeat(${grid.weeks},minmax(4px,16px))` }}
                  >
                    {grid.columns.map((week) =>
                      week.map((cell) => (
                        <button
                          type="button"
                          key={cell.date}
                          className="token-usage__heatmap-cell"
                          data-date={cell.date}
                          data-level={cell.level}
                          data-state={cell.state}
                          aria-label={copy(`${cell.date} · ${count(cell.tokens)} Token · ${cell.turns} 轮`, `${cell.date} · ${count(cell.tokens)} tokens · ${cell.turns} turns`)}
                          aria-pressed={selectedCell?.date === cell.date}
                          disabled={cell.state === "outside"}
                          onPointerEnter={event => { if (cell.state === "outside" || event.pointerType !== "mouse") return; setPreviewCell(cell); }}
                          onPointerLeave={event => { if (event.pointerType === "mouse") setPreviewCell(null); }}
                          onFocus={event => { if (!event.currentTarget.matches(":focus-visible") || document.documentElement.dataset.pointerFocus) return; setPreviewCell(cell); }}
                          onBlur={() => setPreviewCell(null)}
                          onClick={() => { setPreviewCell(null); setSelectedCell(current => current?.date === cell.date ? null : cell); }}
                        />
                      )),
                    )}
                  </div>
                </div>
                <div className="token-usage__heatmap-months" style={{ gridTemplateColumns: `repeat(${grid.weeks},minmax(4px,16px))` }}>
                  {Array.from({ length: grid.weeks }, (_, i) => grid.monthLabels.find((x) => x.index === i)).map((x, i) => (
                    <span key={i}>{x?.label ?? ""}</span>
                  ))}
                </div>
                <p className="token-usage__activity-caption" role="status">
                  {activeCell
                    ? `${activeCell.date} · ${count(activeCell.tokens)} tokens · ${activeCell.turns} ${copy("轮", "turns")}`
                    : copy("选择方格查看当日用量", "Choose a cell for daily usage")}
                </p>
              </>
            ) : (
              <ol className="token-usage__bars" aria-label={activityMode === "weekly" ? copy("按周用量", "Weekly usage") : copy("累计用量", "Cumulative usage")}>
                {bars.map((bar) => {
                  const max = bars.reduce((n, b) => (BigInt(b.tokens) > n ? BigInt(b.tokens) : n), 0n);
                  const pct = max === 0n ? 0 : Number((BigInt(bar.tokens) * 10000n) / max) / 100;
                  return (
                    <li key={bar.key} className="token-usage__bar-row">
                      <span className="token-usage__bar-label">{bar.label}</span>
                      <span className="token-usage__bar-track" aria-hidden="true">
                        <span className="token-usage__bar-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="token-usage__bar-value" title={count(bar.tokens)}>
                        {compactTokens(bar.tokens, locale)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            <details className="token-usage__activity-table">
              <summary className="ui-native-disclosure">{copy("以表格查看", "View as table")}</summary>
              <table className="token-usage__table">
                <thead>
                  <tr>
                    <th>{copy("日期", "Date")}</th>
                    <th>{copy("用量", "Tokens")}</th>
                    <th>{copy("轮次", "Turns")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.daily.map((d) => (
                    <tr key={d.key}>
                      <td>{d.key}</td>
                      <td>{count(d.tokens)}</td>
                      <td>{d.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          {/* Model Usage Section */}
          <SettingsSection title={copy("模型用量", "Usage by model")}>
            {visible.models.length ? (
              <ul className="token-usage__model-grid">
                {visible.models.map((model) => {
                  const pct = modelShare(model.tokens, visible.summary.tokens);
                  const unknown = /\[null,null\]/.test(model.key);
                  return (
                    <li key={model.key} className="token-usage__model-card" data-unknown={unknown || undefined}>
                      <div className="token-usage__model-card-head">
                        <strong>{modelLabel(model.key)}</strong>
                        <span title={count(model.tokens)}>{compactTokens(model.tokens, locale)}</span>
                      </div>
                      <span className="token-usage__model-card-track" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                      <small>
                        {model.turns} {copy("轮", "turns")}
                      </small>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>{copy("该范围暂无模型用量记录。", "No model usage in this range.")}</p>
            )}
          </SettingsSection>

          {/* Detailed Conversation / People / Turn table */}
          <SettingsSection
            title={detailTitle}
            action={
              threadId ? (
                <SettingsButton onClick={returnToSummary}>{copy("返回汇总", "Back to summary")}</SettingsButton>
              ) : (
                <div className="token-usage__detail-actions">
                  <SettingsSelect aria-label={copy("列表", "View")} value={view} onChange={(e) => change(() => setView(e.target.value))}>
                    <option value="threads">{copy("会话汇总", "Conversations")}</option>
                    <option value="turns">{copy("轮次明细", "Turn details")}</option>
                    {visible?.canQueryTeam ? <option value="actors">{copy("人员汇总", "People")}</option> : null}
                  </SettingsSelect>
                  {scope === "team" ? (
                    <SettingsButton onClick={browsePeople}>{actorId ? actorName : copy("全部人员", "All people")}</SettingsButton>
                  ) : null}
                  {actorId ? (
                    <SettingsButton onClick={() => choosePerson("", "")}>{copy("清除人员筛选", "Clear person filter")}</SettingsButton>
                  ) : null}
                </div>
              )
            }
          >
            {visible.rows.length === 0 ? (
              <p>{copy("该筛选范围暂无记录。", "No records match these filters.")}</p>
            ) : details ? (
              <div className="token-usage__table-wrap">
                <table className="token-usage__table">
                  <thead>
                    <tr>
                      <th>{copy("轮次", "Turn")}</th>
                      <th>{copy("时间/状态", "Time / State")}</th>
                      <th>{copy("分摊 / 原始 / 参与人", "Allocated / Raw / Participants")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map((t) => (
                      <tr key={t.turnId}>
                        <td>
                          <span>{t.turnId}</span>
                        </td>
                        <td>
                          {new Date(t.startedAt).toLocaleString(locale)} · {stateLabel(t.allocationState)}
                        </td>
                        <td>
                          {copy(
                            `分摊 ${count(t.allocatedTokens)} · 原始 ${t.rawTokens === null ? "未知" : count(t.rawTokens)} · ${t.participantCount} 人`,
                            `Allocated ${count(t.allocatedTokens)} · Raw ${t.rawTokens === null ? "Unknown" : count(t.rawTokens)} · ${t.participantCount} participants`,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="token-usage__table-wrap">
                <table className="token-usage__table">
                  <thead>
                    <tr>
                      <th>{copy("名称", "Name")}</th>
                      <th>{copy("Tokens", "Tokens")}</th>
                      <th>{copy("轮次", "Turns")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.rows.map((row) =>
                      "key" in row ? (
                        <tr key={row.key}>
                          <td>
                            {view === "threads" ? (
                              <SettingsButton data-usage-thread={row.key} onClick={() => openThread(row.key)}>
                                {row.key}
                              </SettingsButton>
                            ) : view === "actors" ? (
                              <SettingsButton onClick={() => choosePerson(row.key, row.label ?? copy("未知人员", "Unknown person"))}>
                                {row.label ?? copy("未知人员", "Unknown person")}
                              </SettingsButton>
                            ) : (
                              <strong>{row.key}</strong>
                            )}
                          </td>
                          <td title={count(row.tokens)}>{compactTokens(row.tokens, locale)}</td>
                          <td>{row.turns}</td>
                        </tr>
                      ) : null,
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {visible.nextCursor ? (
              <SettingsButton onClick={() => change(() => {}, visible.nextCursor)}>{copy("下一页", "Next page")}</SettingsButton>
            ) : null}
            {cursor ? <SettingsButton onClick={() => change(() => {})}>{copy("回到第一页", "First page")}</SettingsButton> : null}
          </SettingsSection>

          {/* Bottom Diagnostics (Collapsible <details>) */}
          <section className="token-usage__advanced" aria-labelledby="token-usage-advanced-title">
            <h3 id="token-usage-advanced-title">{copy("高级账本与采集诊断", "Advanced ledger & collection diagnostics")}</h3>
            <details className="token-usage__diagnostics">
              <summary className="ui-native-disclosure">{copy("查看运行诊断", "View runtime diagnostics")}</summary>
              <div className="token-usage__diagnostics-actions">
                <span>{visible.coverage.enabled ? copy("计量运行中", "Collection active") : copy("计量已暂停", "Collection paused")}</span>
                {visible.canConfigure ? (
                  <SettingsButton disabled={loading} onClick={() => void configure(!visible.coverage.enabled)}>
                    {visible.coverage.enabled ? copy("暂停计量", "Pause collection") : copy("启用计量", "Enable collection")}
                  </SettingsButton>
                ) : null}
              </div>
              <p>
                {copy("采集始于", "Collection began")} {new Date(visible.coverage.enabledAt).toLocaleString(locale)}
              </p>
              <p>
                {copy("最近成功采集", "Last successful collection")}:{" "}
                {lastSource === null ? copy("暂无成功记录", "No successful collection yet") : new Date(lastSource).toLocaleString(locale)}
              </p>
              <p>
                {copy(
                  `修订 ${visible.snapshotRevision} · 截至 ${new Date(visible.asOf).toLocaleString(locale)} · ${visible.timezone} · ${visible.policyVersion}`,
                  `Revision ${visible.snapshotRevision} · As of ${new Date(visible.asOf).toLocaleString(locale)} · ${visible.timezone} · ${visible.policyVersion}`,
                )}
              </p>
              {visible.coverage.partial ? (
                <SettingsNotice>
                  {copy(
                    `部分数据尚未齐全：${visible.coverage.missingUsage} 个轮次用量不完整，${visible.coverage.openGapIncidents ?? visible.coverage.openGaps} 个未恢复缺口（${visible.coverage.openGaps} 条失败记录）。`,
                    `Partial coverage: ${visible.coverage.missingUsage} turns have incomplete usage; ${visible.coverage.openGapIncidents ?? visible.coverage.openGaps} open gaps (${visible.coverage.openGaps} gap records).`,
                  )}
                </SettingsNotice>
              ) : null}
              <dl className="token-usage__summary">
                <div>
                  <dt>{copy("已结算", "Settled")}</dt>
                  <dd>{count(visible.summary.categories.settled ?? "0")}</dd>
                </div>
                <div>
                  <dt>{copy("暂定", "Provisional")}</dt>
                  <dd>{count(visible.summary.categories.provisional ?? "0")}</dd>
                </div>
                <div>
                  <dt>{copy("待归属", "Pending attribution")}</dt>
                  <dd>{count(visible.summary.categories.pending ?? "0")}</dd>
                </div>
                <div>
                  <dt>{copy("系统", "System")}</dt>
                  <dd>{count(visible.summary.categories.system ?? "0")}</dd>
                </div>
                <div>
                  <dt>{copy("未知", "Unknown")}</dt>
                  <dd>{count(visible.summary.categories.unknown ?? "0")}</dd>
                </div>
              </dl>
              <p>{copy(`未知模型轮次 ${visible.coverage.unknownModelTurns}`, `${visible.coverage.unknownModelTurns} turns with unknown model`)}</p>

              {visible.canQueryTeam && visible.diagnostics ? (
                <>
                  <h4>{copy("本次启动计数", "This process")}</h4>
                  <p>{copy("以下计数仅覆盖本次服务启动以来，不参与用量汇总；延迟为最近256次操作。", "These process-local counters do not contribute to usage totals. Latencies cover the latest 256 operations.")}</p>
                  <dl className="token-usage__summary">
                    {Object.entries(visible.diagnostics.counts).map(([key, value]) => (
                      <div key={key}>
                        <dt>
                          {
                            (
                              {
                                collected: copy("采集", "Collected"),
                                corrected: copy("校正", "Corrected"),
                                deduplicated: copy("去重", "Deduplicated"),
                                excluded: copy("范围外", "Excluded"),
                                missing: copy("缺口", "Gaps"),
                                reconciled: copy("对账", "Reconciled"),
                                writeFailures: copy("落库失败", "Write failures"),
                                queryFailures: copy("查询失败", "Query failures"),
                              } as Record<string, string>
                            )[key]
                          }
                        </dt>
                        <dd>{count(String(value))}</dd>
                      </div>
                    ))}
                  </dl>
                  <p>
                    {copy("落库延迟 p95", "Write latency p95")}: {visible.diagnostics.writeLatency.p95Ms?.toFixed(1) ?? "—"} ms ·{" "}
                    {copy("查询延迟 p95", "Query latency p95")}: {visible.diagnostics.queryLatency.p95Ms?.toFixed(1) ?? "—"} ms
                  </p>
                </>
              ) : null}
            </details>
          </section>
        </>
      ) : null}
    </div>
  );
}
