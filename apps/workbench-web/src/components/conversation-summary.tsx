import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CloseIcon, InfoIcon } from "@opencraft/design-system-web/action-icons";
import type { ConversationSummaryContext, ConversationSummaryViewState } from "@opencraft/workbench-panels-react";
import type { ThreadGoalResource } from "@opencraft/workbench-runtime";
import { useIntl } from "@opencraft/i18n/react";
import { useWorkbenchPanelRuntime } from "../runtime/panel-runtime-context";
import "./conversation-summary.scss";

const ConversationSummarySheet = lazy(() => import("./conversation-summary-sheet"));

const noopSubscribe = () => () => {};
const noGoal = () => null;
export function useSummaryGoal(goals: ThreadGoalResource, threadId: string | null) {
  const subscribe = useCallback((listener: () => void) => threadId === null ? noopSubscribe() : goals.subscribe(threadId, listener), [goals, threadId]);
  const read = useCallback(() => threadId === null ? null : goals.getSnapshot(threadId), [goals, threadId]);
  const snapshot = useSyncExternalStore(subscribe, read, noGoal);
  return snapshot?.goal ?? snapshot?.completedGoal ?? null;
}

export function useConversationSummary(scopeKey: string, available: boolean) {
  const { context } = useWorkbenchPanelRuntime();
  const contribution = useSyncExternalStore(context.conversationSummary.subscribe, context.conversationSummary.getSnapshot, context.conversationSummary.getSnapshot);
  const layoutRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(false);
  const [state, setState] = useState({ scopeKey, pinned: true, modal: false });
  const current = state.scopeKey === scopeKey ? state : { scopeKey, pinned: true, modal: false };
  if (state.scopeKey !== scopeKey) setState(current);
  useLayoutEffect(() => {
    const element = layoutRef.current;
    if (!element || !available || !contribution) return;
    const measure = () => setWide(getComputedStyle(element).getPropertyValue("--summary-wide").trim() === "1");
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [available, contribution]);
  const enabled = available && contribution !== null;
  const open = enabled && (wide ? current.pinned : current.modal);
  return { contribution, layoutRef, triggerRef, wide, open, enabled, scopeKey,
    dismiss: () => setState({ ...current, ...(wide ? { pinned: false } : { modal: false }) }),
    toggle: () => setState({ ...current, ...(wide ? { pinned: !current.pinned } : { modal: !current.modal }) }),
  };
}

type Controller = ReturnType<typeof useConversationSummary>;
export function ConversationSummaryButton({ controller }: { controller: Controller }) {
  const intl = useIntl();
  if (!controller.enabled) return null;
  const title = intl.formatMessage(controller.contribution!.title);
  return <button type="button" ref={controller.triggerRef} className="chrome-button conversation-summary-trigger"
    title={title} aria-label={title} aria-expanded={controller.open} aria-controls="conversation-task-summary" onClick={controller.toggle}>
    <InfoIcon size={18} aria-hidden="true" />
  </button>;
}

export function ConversationSummarySurface({ controller, context }: { controller: Controller; context: ConversationSummaryContext }) {
  const intl = useIntl();
  const [state, setState] = useState<{ scope: string; value: ConversationSummaryViewState }>({ scope: context.scopeKey, value: { collapsed: new Set(), scrollTop: 0 } });
  const viewState = state.scope === context.scopeKey ? state.value : { collapsed: new Set<string>(), scrollTop: 0 };
  if (state.scope !== context.scopeKey) setState({ scope: context.scopeKey, value: viewState });
  if (!controller.open || !controller.contribution) return null;
  const { Component, title } = controller.contribution;
  const label = intl.formatMessage(title);
  const closeLabel = intl.formatMessage({ id: "common.close", defaultMessage: "Close" });
  const content = <><div className="conversation-summary__heading"><h2>{label}</h2>{controller.wide ? <button type="button" className="chrome-button" aria-label={closeLabel} onClick={() => { controller.dismiss(); controller.triggerRef.current?.focus({ preventScroll: true }); }}><CloseIcon size={16} aria-hidden="true" /></button> : null}</div>
    <Suspense fallback={<div className="conversation-summary__loading" aria-busy="true" />}>
      <Component context={{ ...context, onOpenResource: path => { if (!controller.wide) controller.dismiss(); context.onOpenResource(path); }, onOpenThread: threadId => { controller.dismiss(); context.onOpenThread(threadId); } }}
        viewState={viewState} onViewStateChange={value => setState({ scope: context.scopeKey, value })} />
    </Suspense></>;
  return controller.wide ? <aside id="conversation-task-summary" className="conversation-summary" aria-label={label}>{content}</aside>
    : <Suspense fallback={null}><ConversationSummarySheet label={label} closeLabel={closeLabel}
      onDismiss={controller.dismiss} returnFocus={() => controller.triggerRef.current}>
      {content}
    </ConversationSummarySheet></Suspense>;
}
