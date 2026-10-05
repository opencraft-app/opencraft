import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, CirclePause, Pencil, Play, Target, Trash2 } from "lucide-react";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";
import type { ThreadGoalResource, ThreadGoalSnapshot } from "@opencraft/workbench-runtime";
import { ModalSurface } from "./modal/modal-surface";

const STATUS: Record<ThreadGoal["status"], string> = {
  active: "正在推进目标",
  paused: "目标已暂停",
  blocked: "目标需要协助",
  usageLimited: "目标暂受用量限制",
  budgetLimited: "目标已到预算上限",
  complete: "目标已完成",
};

function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return hours > 0 ? `${hours}小时${minutes}分钟` : minutes > 0 ? `${minutes}分钟` : `${total}秒`;
}

export interface ThreadGoalSurfaceProps {
  readonly threadId: string | null;
  readonly goals: ThreadGoalResource;
  readonly portalContainer?: HTMLElement | null;
  readonly children?: (createMenuItem: ((closeMenu: (afterClose?: () => void) => void) => ReactNode) | null) => ReactNode;
}

const NO_THREAD_GOAL: ThreadGoalSnapshot = { goal: null, phase: "idle", busy: false, error: null };

/** Presentation owns only disclosure and an unsaved edit draft. */
export function ThreadGoalSurface({ threadId, goals, portalContainer, children }: ThreadGoalSurfaceProps) {
  const subscribe = useCallback((listener: () => void) => threadId === null ? () => undefined : goals.subscribe(threadId, listener), [goals, threadId]);
  const read = useCallback(() => threadId === null ? NO_THREAD_GOAL : goals.getSnapshot(threadId), [goals, threadId]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const capability = goals.capability();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const presentationScope = useMemo(() => ({}), [goals, threadId]);
  const currentScope = useRef<object | null>(presentationScope);

  useEffect(() => {
    if (threadId !== null && capability?.read) void goals.refresh(threadId).catch(() => undefined);
  }, [capability?.read, goals, threadId]);
  useLayoutEffect(() => {
    currentScope.current = presentationScope;
    setExpanded(false);
    setEditing(false);
    setDraft("");
    setActionError(null);
    return () => { currentScope.current = null; };
  }, [presentationScope]);
  useEffect(() => {
    if (snapshot.goal?.status !== "active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.goal?.status]);
  if (threadId === null || !capability?.read) return children?.(null) ?? null;

  const goal = snapshot.goal;
  const elapsed = goal === null ? 0 : goal.timeUsedSeconds + (goal.status === "active" ? Math.max(0, now / 1000 - goal.updatedAt) : 0);
  const openEditor = () => {
    if (presentationScope !== currentScope.current) return;
    setDraft(goal?.objective ?? ""); setActionError(null); setEditing(true);
  };
  const run = (action: () => Promise<void>) => {
    setActionError(null);
    void action().catch(() => {
      if (presentationScope === currentScope.current) setActionError("操作未完成，请重试。");
    });
  };
  const save = () => {
    const objective = draft.trim();
    if (!objective) { setActionError("请填写目标。"); return; }
    run(async () => {
      await goals.set(threadId, { objective, ...(goal === null ? { status: "active" as const } : {}) });
      if (presentationScope === currentScope.current) setEditing(false);
    });
  };

  const createMenuItem = goal === null && capability.write ? (closeMenu: (afterClose?: () => void) => void) => <DropdownMenu.Item
    className="codex-composer-selection-menu__item codex-composer-add-menu__item"
    disabled={snapshot.busy || snapshot.phase !== "ready"}
    onSelect={(event) => { event.preventDefault(); closeMenu(openEditor); }}
  ><Target size={15} aria-hidden="true" />设定持续目标</DropdownMenu.Item> : null;

  return <>
    {goal !== null || snapshot.phase === "error" || actionError ? <div className="thread-goal" data-goal-status={goal?.status ?? "none"}>
    {goal === null ? null : <>
      <div className="thread-goal__bar">
        <button className="thread-goal__summary" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          <Target size={17} aria-hidden="true" />
          <span className="thread-goal__label">{STATUS[goal.status]}</span>
          <span className="thread-goal__time">{duration(elapsed)}</span>
          <ChevronDown className="thread-goal__chevron" size={15} aria-hidden="true" />
        </button>
      </div>
      {expanded ? <div className="thread-goal__detail">
        <p>{goal.objective}</p>
        {goal.tokenBudget !== null ? <small>已用 {goal.tokensUsed.toLocaleString()} / {goal.tokenBudget.toLocaleString()}</small> : null}
        {capability.write ? <div className="thread-goal__actions">
          <button type="button" disabled={snapshot.busy} onClick={openEditor}><Pencil size={15} /> 编辑</button>
          {goal.status === "active" ? <button type="button" disabled={snapshot.busy} onClick={() => run(() => goals.set(threadId, { status: "paused" }))}><CirclePause size={15} /> 暂停</button>
            : goal.status !== "complete" ? <button type="button" disabled={snapshot.busy} onClick={() => run(() => goals.set(threadId, { status: "active" }))}><Play size={15} /> 继续</button> : null}
          <button type="button" disabled={snapshot.busy} onClick={() => run(() => goals.clear(threadId))}><Trash2 size={15} /> 移除</button>
        </div> : null}
      </div> : null}
    </>}
    {snapshot.phase === "error" ? <button className="thread-goal__error" type="button" onClick={() => void goals.refresh(threadId).catch(() => undefined)}>目标暂时无法更新，点此重试</button> : null}
    {actionError ? <p className="thread-goal__error" role="alert">{actionError}</p> : null}
    </div> : null}
    {children?.(createMenuItem)}
    {editing ? <ModalSurface label={goal === null ? "设定目标" : "编辑目标"} className="thread-goal-dialog" size="default" portalContainer={portalContainer} onDismiss={() => { if (!snapshot.busy) setEditing(false); }}>
      <div className="thread-goal__editor">
        <h2>{goal === null ? "设定持续目标" : "编辑目标"}</h2>
        <p>描述想要达成的结果。目标会在离开页面后继续保留。</p>
        <textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} rows={5} maxLength={4000} aria-label="目标内容" disabled={snapshot.busy} />
        {actionError ? <p role="alert">{actionError}</p> : null}
        <div className="thread-goal__editor-actions">
          <button type="button" onClick={() => setEditing(false)} disabled={snapshot.busy}>取消</button>
          <button type="button" onClick={save} disabled={snapshot.busy || !draft.trim()}><Check size={16} /> 保存</button>
        </div>
      </div>
    </ModalSurface> : null}
  </>;
}
