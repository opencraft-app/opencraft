import { IconButton } from "@opencraft/design-system-web/button";
import { Suspense, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { CloseIcon, InfoIcon } from "@opencraft/design-system-web/action-icons";
import type { ConversationSummaryContext, ConversationSummaryViewState } from "@opencraft/workbench-panels-react";
import type { ThreadGoalResource } from "@opencraft/workbench-runtime";
import { useIntl } from "@opencraft/i18n/react";
import { useWorkbenchPanelRuntime } from "../runtime/panel-runtime-context";
import { useTouchLayout } from "../runtime/use-touch-layout";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import { resolveSummaryPresentation } from "./conversation-summary-layout";
import "./conversation-summary.scss";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [budget, setBudget] = useState({ mode: "overlay" as "overlay" | "shift" | "gutter", panelSpace: 0 });
  useLayoutEffect(() => {
    const element = layoutRef.current, measure = measureRef.current;
    if (!element || !measure || !available || !contribution) return;
    const reading = measure.children[0]!, panel = measure.children[1]!;
    const update = () => {
      const panelSpace = panel.getBoundingClientRect().width;
      const mode = resolveSummaryPresentation(element.getBoundingClientRect().width, reading.getBoundingClientRect().width, panelSpace);
      setBudget(previous => previous.mode === mode && previous.panelSpace === panelSpace ? previous : { mode, panelSpace });
    };
    const observer = new ResizeObserver(update);
    [element, reading, panel].forEach(target => observer.observe(target));
    update();
    return () => observer.disconnect();
  }, [available, contribution]);
  const id = useId();
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [state, setState] = useState<{ scopeKey: string; intent: boolean | null }>({ scopeKey, intent: null });
  const intent = state.scopeKey === scopeKey ? state.intent : null;
  const enabled = available && contribution !== null;
  const open = enabled && (intent ?? budget.mode !== "overlay");
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const setOpen = (next: boolean) => {
    if (currentScope.current === scopeKey) setState({ scopeKey, intent: next });
  };
  return { contribution, triggerRef, layoutRef, measureRef, id, open, enabled, scopeKey, setOpen,
    ...budget, inset: budget.mode === "shift" && open ? budget.panelSpace : 0,
    canRestoreFocus: () => currentScope.current === scopeKey && !currentOpen.current,
    dismiss: () => setOpen(false),
    toggle: () => setOpen(!open),
  };
}

type Controller = ReturnType<typeof useConversationSummary>;

export function ConversationSummaryLayout({ controller, children }: { readonly controller: Controller; readonly children: ReactNode }) {
  const reduced = useReducedMotion();
  return <motion.div ref={controller.layoutRef} className="conversation-summary-layout" data-summary-mode={controller.mode}
    animate={{ paddingInlineEnd: controller.inset }} transition={reduced || controller.mode === "overlay" ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 38, mass: .8 }}>
    <span ref={controller.measureRef} className="conversation-summary__measure" aria-hidden="true"><span /><span /></span>
    {children}
  </motion.div>;
}

function SummaryInline({ id, label, children }: { readonly id: string; readonly label: string; readonly children: ReactNode }) {
  const present = useIsPresent(), reduced = useReducedMotion();
  return <motion.aside id={present ? id : undefined} className="conversation-summary conversation-summary--inline" aria-label={label}
    aria-hidden={!present || undefined} inert={!present || undefined} data-summary-present={present}
    initial={reduced ? false : { opacity: 0, x: 48 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : 48 }}
    transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 38, mass: .8 }}>{children}</motion.aside>;
}
export function ConversationSummaryButton({ controller }: { controller: Controller }) {
  const intl = useIntl();
  if (!controller.enabled) return null;
  const title = intl.formatMessage(controller.contribution!.title);
  return <IconButton variant={controller.open ? "secondary" : "ghost"} type="button" ref={controller.triggerRef} className="chrome-button conversation-summary-trigger"
    title={title} aria-label={title} data-state={controller.open ? "open" : "closed"} aria-expanded={controller.open} aria-controls={controller.id} aria-haspopup={controller.mode === "overlay" ? "dialog" : undefined} onClick={controller.toggle}>
    <InfoIcon size={18} aria-hidden="true" />
  </IconButton>;
}

/** Radix owns dismissal and focus; only the outgoing presentation is retained. */
function SummaryPopup({ controller, label, children, touch, restoreFocus }: {
  readonly controller: Controller; readonly label: string; readonly children: ReactNode;
  readonly touch: boolean; readonly restoreFocus: { current: boolean };
}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const portal = useWorkbenchPresentationRoot();
  return <Popover.Portal forceMount container={portal}>
    <Popover.Content forceMount asChild align="end" side="bottom" sideOffset={12}
      collisionPadding={12} avoidCollisions aria-label={label}
      onInteractOutside={event => {
        if (event.target instanceof Node && controller.triggerRef.current?.contains(event.target)) event.preventDefault();
        else restoreFocus.current = false;
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (restoreFocus.current && controller.canRestoreFocus() && controller.triggerRef.current?.isConnected) controller.triggerRef.current.focus({ preventScroll: true });
      }}>
      <motion.section id={present ? controller.id : undefined} className="conversation-summary" data-summary-touch={touch}
        data-summary-present={present} aria-hidden={!present || undefined} inert={!present || undefined}
        initial={reduced ? false : { opacity: 0, x: touch ? 64 : 12, scale: .98 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, x: touch ? 64 : 12, scale: .98 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 38, mass: .8 }}>
        {children}
      </motion.section>
    </Popover.Content>
  </Popover.Portal>;
}

export function ConversationSummarySurface({ controller, context }: { controller: Controller; context: ConversationSummaryContext }) {
  const intl = useIntl();
  const touch = useTouchLayout();
  const restoreFocus = useRef(true);
  useLayoutEffect(() => { if (controller.open) restoreFocus.current = true; }, [controller.open, context.scopeKey]);
  const anchor = useMemo(() => ({ current: {
    get contextElement() { return controller.triggerRef.current ?? undefined; },
    getBoundingClientRect: () => controller.triggerRef.current?.getBoundingClientRect() ?? new DOMRect(),
  } }), [controller.triggerRef]);
  const [state, setState] = useState<{ scope: string; value: ConversationSummaryViewState }>({ scope: context.scopeKey, value: { collapsed: new Set(), scrollTop: 0 } });
  const viewState = state.scope === context.scopeKey ? state.value : { collapsed: new Set<string>(), scrollTop: 0 };
  if (state.scope !== context.scopeKey) setState({ scope: context.scopeKey, value: viewState });
  if (!controller.enabled || !controller.contribution) return null;
  const { Component, title } = controller.contribution;
  const label = intl.formatMessage(title);
  const closeLabel = intl.formatMessage({ id: "common.close", defaultMessage: "Close" });
  const content = <>
    <header className="conversation-summary__heading">
      <h2 title={context.title || label}>{context.title || label}</h2>
      <IconButton className="conversation-summary__close" aria-label={closeLabel}
        onClick={() => { restoreFocus.current = true; controller.dismiss(); if (controller.mode !== "overlay") controller.triggerRef.current?.focus({ preventScroll: true }); }}><CloseIcon size={16} aria-hidden="true" /></IconButton>
    </header>
    <Suspense fallback={<div className="conversation-summary__loading" aria-busy="true" />}>
      <Component context={{ ...context,
        onOpenResource: path => { if (controller.mode === "overlay") controller.dismiss(); context.onOpenResource(path); },
        onOpenThread: threadId => { controller.dismiss(); context.onOpenThread(threadId); },
      }} viewState={viewState} onViewStateChange={value => setState(previous => previous.scope !== context.scopeKey ? previous : { scope: context.scopeKey, value })} />
    </Suspense>
  </>;
  return <Popover.Root open={controller.mode === "overlay" && controller.open} modal={touch} onOpenChange={next => { if (next) restoreFocus.current = true; controller.setOpen(next); }}>
    <Popover.Anchor virtualRef={anchor} />
    <AnimatePresence initial={false}>
      {controller.open ? controller.mode === "overlay"
        ? <SummaryPopup key={`overlay:${context.scopeKey}`} controller={controller} label={label} touch={touch} restoreFocus={restoreFocus}>{content}</SummaryPopup>
        : <SummaryInline key={`inline:${context.scopeKey}`} id={controller.id} label={label}>{content}</SummaryInline> : null}
    </AnimatePresence>
  </Popover.Root>;
}
