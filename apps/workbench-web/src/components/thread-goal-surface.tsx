import { CheckIcon as Check, ChevronDownIcon as ChevronDown, MoreIcon as MoreHorizontal, EditIcon as Pencil, DeleteIcon as Trash2, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { threadGoalNeedsResume } from "@opencraft/appserver-protocol";
import { useWorkbenchPresentationActive } from "./workbench-presentation-activity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { PausedCircleIcon as CirclePause, PlayIcon as Play, TargetIcon as Target } from "@opencraft/design-system-web/action-icons";
import type { ThreadGoalResource, ThreadGoalSnapshot } from "@opencraft/workbench-runtime";
import { defineMessages, type IntlShape } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { ModalSurface } from "./modal/modal-surface";
import { Button } from "./ui/button";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

const messages = defineMessages({
  active: { id: "goal.status.active", defaultMessage: "Pursuing goal" },
  paused: { id: "goal.status.paused", defaultMessage: "Goal paused" },
  blocked: { id: "goal.status.blocked", defaultMessage: "Goal needs help" },
  usageLimited: { id: "goal.status.usageLimited", defaultMessage: "Goal usage limit reached" },
  budgetLimited: { id: "goal.status.budgetLimited", defaultMessage: "Goal budget limit reached" },
  complete: { id: "goal.status.complete", defaultMessage: "Goal complete" },
  create: { id: "goal.create", defaultMessage: "Set a goal" },
  viewComplete: { id: "goal.viewComplete", defaultMessage: "View completed goal" },
  replaceDescription: { id: "goal.replaceDescription", defaultMessage: "Setting a new goal replaces the completed goal for this conversation." },
  finishedWhileEditing: { id: "goal.finishedWhileEditing", defaultMessage: "This goal is complete. Save your changes to continue pursuing it." },
  saveAndResume: { id: "goal.saveAndResume", defaultMessage: "Save and resume" },
  revert: { id: "goal.revert", defaultMessage: "Revert" },
  editTitle: { id: "goal.editTitle", defaultMessage: "Edit goal" },
  edit: { id: "goal.edit", defaultMessage: "Edit" },
  pause: { id: "goal.pause", defaultMessage: "Pause" },
  resume: { id: "goal.resume", defaultMessage: "Resume" },
  remove: { id: "goal.remove", defaultMessage: "Remove" },
  actions: { id: "goal.actions", defaultMessage: "Goal actions" },
  close: { id: "common.close", defaultMessage: "Close" },
  cancel: { id: "common.cancel", defaultMessage: "Cancel" },
  save: { id: "common.save", defaultMessage: "Save" },
  start: { id: "goal.start", defaultMessage: "Start goal" },
  objective: { id: "goal.objective", defaultMessage: "Goal objective" },
  newDescription: { id: "goal.newDescription", defaultMessage: "Describe the result you want. A new conversation will be created to pursue this goal." },
  description: { id: "goal.description", defaultMessage: "Describe the result you want. Your goal persists when you leave this page." },
  usage: { id: "goal.usage", defaultMessage: "Used {used} / {budget}" },
  refreshError: { id: "goal.refreshError", defaultMessage: "Could not update the goal. Click to retry." },
  actionFailed: { id: "goal.actionFailed", defaultMessage: "The action could not be completed. Please try again." },
  objectiveRequired: { id: "goal.objectiveRequired", defaultMessage: "Enter a goal objective." },
  days: { id: "goal.duration.days", defaultMessage: "{days, plural, one {# day} other {# days}} {hours, plural, one {# hour} other {# hours}} {minutes, plural, one {# minute} other {# minutes}}" },
  hours: { id: "goal.duration.hours", defaultMessage: "{hours, plural, one {# hour} other {# hours}} {minutes, plural, one {# minute} other {# minutes}}" },
  minutes: { id: "goal.duration.minutes", defaultMessage: "{minutes, plural, one {# minute} other {# minutes}}" },
  seconds: { id: "goal.duration.seconds", defaultMessage: "{seconds, plural, one {# second} other {# seconds}}" },
});

function compactDuration(seconds: number, intl: IntlShape): string {
  const total = Math.max(0, Math.floor(seconds));
  const parts: [number, "day" | "hour" | "minute" | "second"][] = total >= 86400
    ? [[Math.floor(total / 86400), "day"], [Math.floor(total % 86400 / 3600), "hour"]]
    : total >= 3600 ? [[Math.floor(total / 3600), "hour"], [Math.floor(total % 3600 / 60), "minute"]]
      : total >= 60 ? [[Math.floor(total / 60), "minute"]] : [[total, "second"]];
  return parts.map(([value, unit]) => intl.formatNumber(value, { style: "unit", unit, unitDisplay: "narrow" })).join(" ");
}

function duration(seconds: number, intl: IntlShape): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return intl.formatMessage(messages[days > 0 ? "days" : hours > 0 ? "hours" : minutes > 0 ? "minutes" : "seconds"], { days, hours, minutes, seconds: total });
}

export interface ThreadGoalSurfaceProps {
  readonly threadId: string | null;
  readonly goals: ThreadGoalResource;
  readonly draftScope?: object;
  readonly onCreateGoal?: (objective: string) => Promise<void>;
  readonly disabled?: boolean;
  readonly portalContainer?: HTMLElement | null;
  readonly children?: (goalMenuItems: ((closeMenu: (afterClose?: () => void) => void) => ReactNode) | null, busy: boolean, attachedContent: ReactNode) => ReactNode;
}

// Radix exposes the owning trigger through the menu's accessible label.
function menuReturnFocus(event: Event): HTMLElement | null {
  const item = event.target instanceof Element ? event.target : null;
  const triggerId = item?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
  return triggerId ? item?.ownerDocument.getElementById(triggerId) ?? null : null;
}

const NO_THREAD_GOAL: ThreadGoalSnapshot = { goal: null, completedGoal: null, phase: "idle", busy: false, error: null };

/** Presentation owns only disclosure and an unsaved edit draft. */
export function ThreadGoalSurface({ threadId, goals, draftScope, onCreateGoal, disabled = false, portalContainer, children }: ThreadGoalSurfaceProps) {
  const intl = useIntl();
  const presentationActive = useWorkbenchPresentationActive();
  const presentationRoot = useWorkbenchPresentationRoot();
  const afterMenuClose = useRef<(() => void) | null>(null);
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const editorReturnFocus = useRef<HTMLElement | null>(null);
  const subscribe = useCallback((listener: () => void) => threadId === null ? () => undefined : goals.subscribe(threadId, listener), [goals, threadId]);
  const read = useCallback(() => threadId === null ? NO_THREAD_GOAL : goals.getSnapshot(threadId), [goals, threadId]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const goal = snapshot.goal ?? snapshot.completedGoal;
  const capability = goals.capability(threadId ?? undefined);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | "view" | null>(null);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<"actionFailed" | "objectiveRequired" | null>(null);
  const presentationScope = useMemo(() => ({}), [goals, threadId, draftScope]);
  const currentScope = useRef<object | null>(presentationScope);

  useEffect(() => {
    if (threadId !== null && capability?.read) void goals.refresh(threadId).catch(() => undefined);
  }, [capability?.read, goals, threadId]);
  useLayoutEffect(() => {
    currentScope.current = presentationScope;
    setCreating(false);
    creatingRef.current = false;
    setExpanded(false);
    afterMenuClose.current = null;
    setEditorMode(null);
    setDraft("");
    setActionError(null);
    return () => { currentScope.current = null; };
  }, [presentationScope]);
  useEffect(() => {
    if (!presentationActive || capability?.usageAccounting === false || goal?.status !== "active") return;
    let displayedTime: number | null = null;
    const refresh = () => {
      const next = Date.now();
      const seconds = Math.max(0, Math.floor(goal.timeUsedSeconds + Math.max(0, next / 1000 - goal.updatedAt)));
      // Both duration labels show seconds below a minute, then whole minutes.
      // Keep sampling for clock/accounting changes without rerendering the Composer
      // when neither the summary nor the detailed elapsed label can change.
      const displayTime = seconds < 60 ? seconds : 60 + Math.floor(seconds / 60);
      if (displayTime === displayedTime) return;
      displayedTime = displayTime;
      setNow(next);
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [presentationActive, threadId, goal?.status, goal?.timeUsedSeconds, goal?.updatedAt, capability?.usageAccounting]);
  useEffect(() => {
    if (goal?.status === "complete") setExpanded(false);
    else setEditorMode(mode => mode === "view" ? null : mode);
  }, [goal?.status]);
  const newGoal = threadId === null && onCreateGoal !== undefined;
  const busy = snapshot.busy || creating;
  if ((!newGoal && threadId === null) || !capability?.read) return children?.(null, false, null) ?? null;

  const elapsed = goal === null ? 0 : goal.timeUsedSeconds + (goal.status === "active" ? Math.max(0, now / 1000 - goal.updatedAt) : 0);
  const openEditor = (opener?: HTMLElement | null, mode: "create" | "edit" | "view" = goal === null ? "create" : "edit") => {
    if (presentationScope !== currentScope.current) return;
    editorReturnFocus.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDraft(mode === "create" ? "" : goal?.objective ?? ""); setActionError(null); setEditorMode(mode);
  };
  const run = (action: () => Promise<void>) => {
    setActionError(null);
    void action().catch(() => {
      if (presentationScope === currentScope.current) setActionError("actionFailed");
    });
  };
  const save = () => {
    const objective = draft.trim();
    if (busy || disabled || !capability.write || creatingRef.current || (editorMode === "edit" && snapshot.goal === null)) return;
    if (!objective) { setActionError("objectiveRequired"); return; }
    run(async () => {
      if (newGoal) {
        creatingRef.current = true;
        setCreating(true);
        try { await onCreateGoal(objective); }
        finally {
          if (presentationScope === currentScope.current) {
            creatingRef.current = false;
            setCreating(false);
          }
        }
      } else if (threadId !== null) {
        if (editorMode === "create") await goals.create(threadId, objective);
        else await goals.set(threadId, { objective, ...(goal?.status === "complete" ? { status: "active" as const } : {}) });
      }
      if (presentationScope === currentScope.current) setEditorMode(null);
    });
  };

  // Completion retires the work control, not the server-owned Goal record.
  const completed = goal?.status === "complete";
  const canCreate = (goal === null || completed) && capability.write;
  const goalMenuItems = canCreate || completed ? (closeMenu: (afterClose?: () => void) => void) => <>
    {completed ? <DropdownMenu.Item
      className="opencraft-composer-selection-menu__item opencraft-composer-add-menu__item"
      onSelect={event => { event.preventDefault(); const opener = menuReturnFocus(event); closeMenu(() => openEditor(opener, "view")); }}
    ><Target size={15} aria-hidden="true" />{intl.formatMessage(messages.viewComplete)}</DropdownMenu.Item> : null}
    {canCreate ? <DropdownMenu.Item
      className="opencraft-composer-selection-menu__item opencraft-composer-add-menu__item"
      disabled={disabled || busy || (!newGoal && snapshot.phase !== "ready")}
      onSelect={event => { event.preventDefault(); const opener = menuReturnFocus(event); closeMenu(() => openEditor(opener, "create")); }}
    ><Target size={15} aria-hidden="true" />{intl.formatMessage(messages.create)}</DropdownMenu.Item> : null}
  </> : null;

  const overlayContainer = portalContainer ?? presentationRoot ?? undefined;
  const summaryLabel = goal === null ? "" : intl.formatMessage(messages[threadGoalNeedsResume(goal) ? "paused" : goal.status]);
  const elapsedLabel = duration(elapsed, intl);
  const showUsage = capability.usageAccounting !== false;
  const needsResume = threadGoalNeedsResume(goal);
  const goalContent = !completed && (goal !== null || snapshot.phase === "error" || actionError) ? <div className="thread-goal" data-goal-status={needsResume ? "paused" : goal?.status ?? "none"}>
    {goal === null || threadId === null ? null : <div className="thread-goal__bar">
      <Popover.Root open={expanded} onOpenChange={setExpanded}>
        <Popover.Trigger asChild>
          <button ref={summaryRef} className="thread-goal__summary" type="button">
            <Target className="thread-goal__target" size={16} aria-hidden="true" />
            <span className="thread-goal__label">{summaryLabel}</span>
            <span className="thread-goal__preview">{goal.objective}</span>
            {showUsage ? <span className="thread-goal__time" title={elapsedLabel}>{compactDuration(elapsed, intl)}</span> : null}
            <ChevronDown className="thread-goal__chevron" size={14} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal container={overlayContainer}>
          <Popover.Content className="thread-goal__detail" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label={intl.formatMessage(messages.objective)}>
            <div className="thread-goal__detail-heading"><Target size={16} aria-hidden="true" /><span>{summaryLabel}</span>
              <Popover.Close asChild><Button variant="ghost" size="sm" aria-label={intl.formatMessage(messages.close)}><X size={16} aria-hidden="true" /></Button></Popover.Close>
            </div>
            <p>{goal.objective}</p>
            <div className="thread-goal__metrics">{showUsage ? <span>{elapsedLabel}</span> : null}
              {goal.tokenBudget !== null ? <small>{intl.formatMessage(messages.usage, { used: intl.formatNumber(goal.tokensUsed), budget: intl.formatNumber(goal.tokenBudget) })}</small> : null}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {capability.write ? <div className="thread-goal__actions">
        {goal.status === "active" && !needsResume ? <Button variant="ghost" size="sm" disabled={busy || disabled} aria-label={intl.formatMessage(messages.pause)} title={intl.formatMessage(messages.pause)} onClick={() => run(() => goals.set(threadId, { status: "paused" }))}><CirclePause size={16} aria-hidden="true" /></Button>
          : goal.status !== "complete" ? <Button variant="ghost" size="sm" disabled={busy || disabled} aria-label={intl.formatMessage(messages.resume)} title={intl.formatMessage(messages.resume)} onClick={() => run(() => goals.set(threadId, { status: "active" }))}><Play size={16} aria-hidden="true" /></Button> : null}
        <Button ref={editRef} className="thread-goal__edit" variant="ghost" size="sm" disabled={busy || disabled} aria-label={intl.formatMessage(messages.edit)} title={intl.formatMessage(messages.edit)} onClick={() => openEditor(editRef.current)}><Pencil size={16} aria-hidden="true" /></Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><Button ref={actionsRef} variant="ghost" size="sm" disabled={busy || disabled} aria-label={intl.formatMessage(messages.actions)} title={intl.formatMessage(messages.actions)}><MoreHorizontal size={16} aria-hidden="true" /></Button></DropdownMenu.Trigger>
          <DropdownMenu.Portal container={overlayContainer}>
            <DropdownMenu.Content className="opencraft-composer-selection-menu thread-goal__menu" side="top" align="end" sideOffset={8} collisionPadding={12} onCloseAutoFocus={event => {
              const action = afterMenuClose.current;
              if (action) { event.preventDefault(); afterMenuClose.current = null; action(); }
            }}>
              <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={() => { afterMenuClose.current = () => openEditor(actionsRef.current); }}><Pencil size={15} aria-hidden="true" />{intl.formatMessage(messages.edit)}</DropdownMenu.Item>
              <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={() => run(() => goals.clear(threadId))}><Trash2 size={15} aria-hidden="true" />{intl.formatMessage(messages.remove)}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div> : null}
    </div>}
    {snapshot.phase === "error" ? <Button className="thread-goal__error" variant="ghost" size="sm" onClick={() => { if (threadId !== null) void goals.refresh(threadId).catch(() => undefined); }}>{intl.formatMessage(messages.refreshError)}</Button> : null}
    {actionError ? <p className="thread-goal__error" role="alert">{intl.formatMessage(messages[actionError])}</p> : null}
  </div> : null;

  return <>
    {children ? children(goalMenuItems, busy, goalContent) : goalContent}
    {editorMode !== null ? <ModalSurface label={intl.formatMessage(editorMode === "view" ? messages.viewComplete : editorMode === "create" ? messages.create : messages.editTitle)} className="thread-goal-dialog" size="default" portalContainer={portalContainer} returnFocus={() => {
      const opener = editorReturnFocus.current;
      return opener?.isConnected && opener.getClientRects().length ? opener : summaryRef.current;
    }} onDismiss={() => { if (!busy) setEditorMode(null); }}>
      <div className="thread-goal__editor">
        <h2>{intl.formatMessage(editorMode === "view" ? messages.viewComplete : editorMode === "create" ? messages.create : messages.editTitle)}</h2>
        {editorMode === "view" ? <>
          <p>{summaryLabel}</p>
          <p className="thread-goal__completed-objective">{goal?.objective}</p>
          <div className="thread-goal__metrics">{showUsage ? <span>{elapsedLabel}</span> : null}
            {goal?.tokenBudget != null ? <small>{intl.formatMessage(messages.usage, { used: intl.formatNumber(goal.tokensUsed), budget: intl.formatNumber(goal.tokenBudget) })}</small> : null}
          </div>
          {snapshot.phase === "error" && threadId !== null ? <Button variant="ghost" disabled={busy} onClick={() => { void goals.refresh(threadId).catch(() => undefined); }}>{intl.formatMessage(messages.refreshError)}</Button> : null}
          {actionError ? <p role="alert">{intl.formatMessage(messages[actionError])}</p> : null}
          <div className="thread-goal__editor-actions">
            {capability.write && threadId !== null && goal !== null ? <Button variant="ghost" disabled={busy || disabled} onClick={() => run(async () => {
              await goals.clear(threadId);
              if (presentationScope === currentScope.current) setEditorMode(null);
            })}><Trash2 size={16} aria-hidden="true" />{intl.formatMessage(messages.remove)}</Button> : null}
            {capability.write && snapshot.goal !== null && threadId !== null ? <>
              <Button variant="ghost" disabled={busy || disabled} onClick={() => openEditor(editorReturnFocus.current, "edit")}><Pencil size={16} aria-hidden="true" />{intl.formatMessage(messages.edit)}</Button>
              <Button disabled={busy || disabled} onClick={() => run(async () => {
                await goals.set(threadId, { status: "active" });
                if (presentationScope === currentScope.current) setEditorMode(null);
              })}><Play size={16} aria-hidden="true" />{intl.formatMessage(messages.resume)}</Button>
            </> : <Button onClick={() => setEditorMode(null)} disabled={busy}>{intl.formatMessage(messages.close)}</Button>}
          </div>
        </> : <>
          <p>{intl.formatMessage(newGoal ? messages.newDescription : editorMode === "create" && completed ? messages.replaceDescription : editorMode === "edit" && completed ? messages.finishedWhileEditing : messages.description)}</p>
          <textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} rows={5} maxLength={4000} aria-label={intl.formatMessage(messages.objective)} disabled={busy} />
          {actionError ? <p role="alert">{intl.formatMessage(messages[actionError])}</p> : null}
          <div className="thread-goal__editor-actions">
            <Button variant="ghost" onClick={() => setEditorMode(null)} disabled={busy}>{intl.formatMessage(messages.cancel)}</Button>
            {editorMode === "edit" ? <Button variant="ghost" disabled={busy || draft === goal?.objective} onClick={() => { setDraft(goal?.objective ?? ""); setActionError(null); }}>{intl.formatMessage(messages.revert)}</Button> : null}
            <Button onClick={save} disabled={disabled || busy || !capability.write || !draft.trim() || (editorMode === "edit" && snapshot.goal === null)}><Check size={16} aria-hidden="true" />{intl.formatMessage(newGoal ? messages.start : editorMode === "edit" && completed ? messages.saveAndResume : messages.save)}</Button>
          </div>
        </>}
      </div>
    </ModalSurface> : null}
  </>;
}
