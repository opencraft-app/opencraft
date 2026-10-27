import { RefreshIcon as RefreshCw } from "@opencraft/design-system-web/action-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { PulseIcon as Activity, ArrowUpRightIcon as ArrowUpRight, DoubleCheckIcon as CheckCheck, LayersIcon as Layers3, PinIcon as Pin, PeopleIcon as Users } from "@opencraft/design-system-web/action-icons";
import { SettingsButton, SettingsNotice, SettingsSelect, SettingsTextInput, type PlatformViewHost } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { legacyDirectServerProjectionFromHost } from "@opencraft/workbench-runtime";
import { periodBounds, projectOverview, type ConversationOverviewPort, type ConversationOverviewSnapshot, type OverviewConversation, type OverviewPeriod, type OverviewState } from "./conversation-overview-model";
import "./conversation-overview.scss";

export function ConversationOverview({ port, host }: { port: ConversationOverviewPort; host: PlatformViewHost }) {
  const zh = useIntl().locale.startsWith("zh"), text = (cn: string, en: string) => zh ? cn : en;
  const sources = host.profiles.filter(profile => profile.enabled).map(profile => ({ id: profile.hostId, label: profile.displayName }));
  const scope = JSON.stringify(sources), live = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationOverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [count, setCount] = useState(0);
  const [period, setPeriod] = useState<OverviewPeriod>("7d"), [source, setSource] = useState("all");
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [peopleLimit, setPeopleLimit] = useState(20), [liveLimit, setLiveLimit] = useState(10);
  const reload = useRef(() => {});
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (live.current || !mounted) return;
      const abort = new AbortController(); live.current = abort;
      setLoading(true); setError(false); setCount(0);
      try {
        const value = await port.read(JSON.parse(scope), abort.signal, value => { if (mounted && !abort.signal.aborted) setCount(count => Math.max(count, value)); });
        if (mounted && !abort.signal.aborted) {
          const unavailable = value.sources.length > 0 && value.sources.every(source => source.catalog === "error");
          setError(unavailable);
          setSnapshot(previous => unavailable && previous?.sources.some(source => source.catalog !== "error") ? previous : value);
        }
      } catch { if (mounted && !abort.signal.aborted) setError(true); }
      finally { if (live.current === abort) live.current = null; if (mounted) setLoading(false); }
    };
    setSnapshot(null); reload.current = () => { void load(); }; void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted = false; live.current?.abort(); live.current = null; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [port, scope]);
  const now = snapshot?.asOf ?? Date.now(), [start, end] = periodBounds(period, now, from, to);
  const valid = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const available = !!snapshot?.sources.some(item => (source === "all" || item.id === source) && item.catalog !== "error");
  const rows = useMemo(() => snapshot?.conversations.filter(row => source === "all" || row.hostId === source) ?? [], [snapshot, source]);
  const model = useMemo(() => projectOverview(rows, start, end), [rows, start, end]);
  const stateText = (state: OverviewState) => ({ running: text("运行中", "Running"), waiting: text("等待操作", "Waiting"), completed: text("已完成", "Completed"), failed: text("失败", "Failed"), interrupted: text("已中断", "Interrupted"), empty: text("尚无轮次", "No turns"), unknown: text("待确认", "Unknown") })[state];
  const running = rows.filter(row => row.state === "running" || row.state === "waiting");
  const maxTrend = Math.max(1, ...model.trend.flatMap(item => [item.created, item.completed]));
  const number = (value: number) => value.toLocaleString(zh ? "zh-CN" : "en-US");
  const shortDate = (date: number) => new Date(date).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" });
  const open = (row: OverviewConversation) => {
    const profile = host.profiles.find(profile => profile.hostId === row.hostId);
    if (profile) void host.openConversation?.(legacyDirectServerProjectionFromHost({ hostId: profile.hostId, hostKind: profile.hostKind, label: profile.displayName }).serverOrigin.serverId, row.id);
  };
  const metrics = [
    { label: text("会话总数", "All conversations"), value: rows.length, icon: Layers3, hint: text("包含归档 · 当前来源", "Includes archived · selected sources") },
    { label: text("正在运行", "Running now"), value: model.states.running, icon: Activity, hint: text("另有", "Also") + ` ${model.states.waiting} ` + text("个等待操作", "waiting for input") },
    { label: text("已完成", "Completed"), value: model.states.completed, icon: CheckCheck, hint: text("最新轮成功，且未运行", "Latest turn succeeded; no active run") },
    { label: text("已置顶", "Pinned"), value: snapshot?.sources.some(item => (source === "all" || item.id === source) && item.pins) ? rows.filter(row => row.pinned).length : null, icon: Pin, hint: text("原生置顶状态", "Native pinned state") },
  ];
  return <section className="conversation-overview" aria-label={text("协同会话统计", "Conversation overview")} aria-busy={loading}>
    <div className="conversation-overview__intro"><div><h3>{text("协同会话全景", "Conversations at a glance")}</h3><p>{text("看清当前进展，了解团队如何协作。", "Current progress and how your team collaborates.")}</p></div><SettingsButton variant="quiet" disabled={loading} onClick={() => reload.current()}><RefreshCw size={16} aria-hidden="true" />{text("刷新统计", "Refresh")}</SettingsButton></div>
    <div className="conversation-overview__freshness" role="status">{error ? snapshot?.sources.some(source => source.catalog !== "error") ? text("刷新失败，保留上次统计，请重试。", "Refresh failed. Previous results retained.") : text("暂时无法读取统计，请点击刷新。", "Could not read statistics. Try Refresh.") : loading ? `${text("正在读取完整目录与最新轮次…", "Reading full catalogs and latest turns…")} ${number(count)}` : snapshot ? `${text("更新于", "Updated")} ${new Date(snapshot.asOf).toLocaleTimeString()} · ${text("每 30 秒刷新", "Refreshes every 30 seconds")}` : text("尚未读取", "Not loaded")}</div>
    <div className="conversation-overview__controls"><label>{text("数据来源", "Sources")}<SettingsSelect value={source} onChange={e => { setSource(e.target.value); setPeopleLimit(20); }}><option value="all">{text("全部来源", "All sources")}</option>{sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</SettingsSelect></label><p>{text("全局指标反映当前快照，不受下方时间筛选影响。", "Global metrics describe the current snapshot, independent of the period below.")}</p></div>
    {snapshot?.sources.some(item => item.catalog !== "complete" || !item.pins || !item.people || item.unknownTurns > 0) ? <SettingsNotice>{text("部分数据尚未确认，以下数字为已读取结果；缺失来源不计为零。", "Some data is unconfirmed. Counts cover retrieved records; missing sources are not zero.")}</SettingsNotice> : null}
    {snapshot && !sources.length ? <SettingsNotice>{text("暂无已启用的会话来源。请先连接一个环境。", "No conversation sources enabled. Connect an environment first.")}</SettingsNotice> : null}
    <div className="conversation-overview__metrics">{metrics.map(({ label, value, icon: Icon, hint }) => <article key={label} className="conversation-overview__metric"><div><span>{label}</span><Icon size={18} aria-hidden="true" /></div><strong>{available && value !== null ? number(value) : "—"}</strong><small>{hint}</small></article>)}</div>
    {available ? <>
    <div className="conversation-overview__current"><div><h4>{text("当前状态分布", "Current states")}</h4><div className="conversation-overview__state-bar" aria-hidden="true">{Object.entries(model.states).filter(([, value]) => value > 0).map(([state, value]) => <i key={state} data-state={state} style={{ flex: value }} />)}</div><ul className="conversation-overview__states">{Object.entries(model.states).map(([state, value]) => <li key={state}><i data-state={state} /><span>{stateText(state as OverviewState)}</span><strong>{available ? number(value) : "—"}</strong></li>)}</ul></div><div className="conversation-overview__retained"><h4>{text("会话留存", "Retained conversations")}</h4><p><span>{text("未归档", "Unarchived")}</span><strong>{snapshot ? number(rows.filter(row => !row.archived).length) : "—"}</strong></p><p><span>{text("已归档", "Archived")}</span><strong>{snapshot ? number(rows.filter(row => row.archived).length) : "—"}</strong></p><small>{text("归档与完成是两个独立维度。", "Archiving and completion are independent.")}</small></div></div>
    <div className="conversation-overview__period"><div><h4>{text("时间洞察", "Over time")}</h4><p>{text("日期按当前设备时区计算。", "Dates use this device’s time zone.")}</p></div><SettingsSelect aria-label={text("统计时间段", "Analysis period")} value={period} onChange={e => { setPeriod(e.target.value as OverviewPeriod); setPeopleLimit(20); }}><option value="today">{text("今天", "Today")}</option><option value="7d">{text("最近 7 天", "Last 7 days")}</option><option value="30d">{text("最近 30 天", "Last 30 days")}</option><option value="90d">{text("最近 90 天", "Last 90 days")}</option><option value="all">{text("全部时间", "All time")}</option><option value="custom">{text("自定义日期", "Custom dates")}</option></SettingsSelect>{period === "custom" ? <><label>{text("开始日期", "From")}<SettingsTextInput type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>{text("结束日期", "To")}<SettingsTextInput type="date" value={to} onChange={e => setTo(e.target.value)} /></label></> : null}</div>
    {!valid ? <SettingsNotice>{text("请选择有效的起止日期。", "Choose a valid date range.")}</SettingsNotice> : <>
      <div className="conversation-overview__period-totals"><span>{text("期间新增", "New")} <b>{number(model.created)}</b></span><span>{text("期间完成", "Completed")} <b>{number(model.completed)}</b></span><span>{text("期间活跃", "Active")} <b>{number(model.active.length)}</b></span><span><Users size={15} aria-hidden="true" />{text("参与人数", "Participants")} <b>{model.active.length && !model.knownPeople ? "—" : number(model.people.filter(person => person.conversations > 0).length)}</b></span><span>{text("多人协作会话", "Collaborative conversations")} <b>{model.active.length && !model.knownPeople ? "—" : number(model.collaborative)}</b></span></div>
      <figure className="conversation-overview__chart"><figcaption><h4>{text("新增与完成趋势", "New and completed")}</h4><span><i className="conversation-overview__legend--created" />{text("新增", "New")}<i className="conversation-overview__legend--completed" />{text("完成", "Completed")}</span></figcaption><div className="conversation-overview__bars">{model.trend.map(bucket => <div key={bucket.start} className="conversation-overview__bucket" title={`${new Date(bucket.start).toLocaleDateString()} – ${new Date(bucket.end - 1).toLocaleDateString()}`}><div><span data-kind="created" style={{ height: `${bucket.created / maxTrend * 100}%` }} aria-label={`${text("新增", "New")} ${bucket.created}`}>{bucket.created > 0 ? bucket.created : ""}</span><span data-kind="completed" style={{ height: `${bucket.completed / maxTrend * 100}%` }} aria-label={`${text("完成", "Completed")} ${bucket.completed}`}>{bucket.completed > 0 ? bucket.completed : ""}</span></div><small>{shortDate(bucket.start)}</small></div>)}</div><p>{text("完成：当前最新一轮成功且无运行任务的会话，按该轮真实完成日期归属；每个会话最多计一次。不是全部历史完成轮次数。", "Completion counts conversations whose latest turn succeeded and have no active run, dated by that turn’s completion. Each conversation counts once; this is not historical turn throughput.")}</p></figure>
      {rows.some(row => row.state === "completed" && row.completedAt === null) ? <SettingsNotice>{text("部分已完成会话缺少原生完成时间，未计入完成趋势。", "Completed conversations without native completion timestamps are excluded from the trend.")}</SettingsNotice> : null}
      <div className="conversation-overview__panel"><h4>{text("人员参与", "Participation")}</h4><p>{text("期间活跃以会话最近更新时间为准。统计这些会话中曾真实发言的人员；参与会话数可重叠，不代表个人发言次数或工作量。创建数独立呈现。", "Activity uses the conversation’s last update time. People with accepted messages in those conversations. Counts overlap and do not measure message volume or workload. Creation is shown separately.")}</p><small>{text("人员数据已确认", "Verified people data")} {number(model.knownPeople)} / {number(model.active.length)} {text("个期间活跃会话", "active conversations")}</small>{model.people.length ? <><div className="conversation-overview__table-wrap"><table><thead><tr>{[text("人员", "Person"), text("参与会话", "Conversations"), text("当前运行 / 等待", "Running / waiting"), text("当前完成", "Completed now"), text("已置顶", "Pinned"), text("创建会话", "Created")].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{model.people.slice(0, peopleLimit).map(person => <tr key={person.id}><th scope="row">{person.id}</th><td>{person.conversations}</td><td>{person.running}</td><td>{person.completed}</td><td>{person.pinned}</td><td>{person.created}</td></tr>)}</tbody></table></div>{peopleLimit < model.people.length ? <SettingsButton variant="ghost" onClick={() => setPeopleLimit(value => value + 20)}>{text("查看更多人员", "More people")}</SettingsButton> : null}{peopleLimit > 20 ? <SettingsButton variant="ghost" onClick={() => setPeopleLimit(20)}>{text("收起", "Collapse")}</SettingsButton> : null}</> : <p className="conversation-overview__empty">{model.active.length && !model.knownPeople ? text("人员数据未接入或仍在同步，暂不能分析。", "People data is unavailable or synchronizing.") : text("此时间段暂无已知人员参与。", "No known participation in this period.")}</p>}</div>
      <div className="conversation-overview__panel"><h4>{text("活跃项目 · 前 12 项", "Active projects · top 12")}</h4>{model.projects.length ? <div className="conversation-overview__table-wrap"><table><thead><tr><th scope="col">{text("项目目录", "Project directory")}</th><th scope="col">{text("期间活跃", "Active")}</th><th scope="col">{text("当前运行 / 等待", "Running / waiting")}</th><th scope="col">{text("当前完成", "Completed now")}</th></tr></thead><tbody>{model.projects.slice(0, 12).map((project, index) => <tr key={index}><th scope="row" title={project.name}>{project.name}</th><td>{project.total}</td><td>{project.running}</td><td>{project.completed}</td></tr>)}</tbody></table></div> : <p className="conversation-overview__empty">{text("此时间段暂无活跃项目。", "No active projects in this period.")}</p>}</div>
    </>}
    <div className="conversation-overview__panel"><h4><Activity size={17} aria-hidden="true" />{text("当前运行与等待", "Running and waiting now")} <span>{running.length}</span></h4>{running.length ? <><ul className="conversation-overview__live">{running.slice(0, liveLimit).map(row => <li key={`${row.hostId}:${row.id}`}><button type="button" disabled={!host.openConversation} onClick={() => open(row)}><span>{row.title}</span><ArrowUpRight size={15} aria-hidden="true" /></button><small>{sources.find(source => source.id === row.hostId)?.label}</small><span data-state={row.state}>{stateText(row.state)}</span></li>)}</ul>{liveLimit < running.length ? <SettingsButton variant="ghost" onClick={() => setLiveLimit(value => value + 10)}>{text("查看更多", "Show more")}</SettingsButton> : null}</> : <p className="conversation-overview__empty">{text("已读取的会话中暂无运行任务。", "No running tasks in retrieved conversations.")}</p>}</div>
    </> : null}
    <details className="conversation-overview__coverage"><summary className="ui-native-disclosure">{text("数据范围与读取情况", "Data scope and coverage")}</summary><p>{text("覆盖当前已启用且可读取的来源，包含归档会话；不包含临时会话与原生目录默认排除的子代理。来源未连接时请先打开该环境。", "Enabled readable sources, including archives. Ephemeral conversations and subagents excluded by the native catalog are omitted. Open disconnected environments to connect them.")}</p>{snapshot?.sources.map(item => <p key={item.id}><strong>{item.label}</strong> · {item.catalog === "complete" ? text("目录完整", "Complete catalog") : item.catalog === "partial" ? text("目录部分读取", "Partial catalog") : text("目录不可用", "Catalog unavailable")} · {item.pins ? text("置顶已读取", "Pins loaded") : text("置顶待确认", "Pins unknown")} · {text("轮次未确认", "Unknown turns")} {item.unknownTurns} · {item.people ? text("人员已读取", "People loaded") : text("人员未完整读取", "People incomplete")}</p>)}</details>
  </section>;
}
