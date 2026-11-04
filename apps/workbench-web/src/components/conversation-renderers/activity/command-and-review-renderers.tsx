import { CheckIcon as Check, ChevronRightIcon as ChevronRight, CopyIcon as Copy } from "@opencraft/design-system-web/action-icons";
import {
  formatAutomaticApprovalReviewSummary,
  formatAutomaticApprovalReviewTitle,
  formatToolDuration,
  formatCommandActivitySummary,
  isAutomaticApprovalReviewWarning,
  presentReasoning,
  skillReadPresentation,
  summarizeAutomaticApprovalReviewAction,
  type AutomaticApprovalReview,
  type ReasoningContentPresentation,
  type TimelineBlock,
} from "@opencraft/chat-core";
import {
  AnsiTerminalText,
  WebChatDocument,
  normalizeTerminalOutput,
  resolveStandardChatResource,
  writeTextToClipboard,
  writeToClipboard,
} from "@opencraft/chat-render-web";
import { useIntl } from "@opencraft/i18n/react";
import { AlertIcon as AlertCircle, ThinkingActivityIcon as Brain, ReviewShieldIcon } from "@opencraft/design-system-web/action-icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ConversationDocumentContext } from "../../conversation/document-context";
import { CommandViewStateContext } from "../../conversation/command-view-state";
import { ThinkingActivityIcon } from "../../activity-glyphs";
import { ThinkingLabel } from "../../thinking-label";
import { useWorkbenchPresentationActive } from "../../workbench-presentation-activity";
import { ConversationDetailContext, useToolActivityPresentation, useHistoryItemDetail } from "../render-contexts";
import { ActivityDisclosure, CadencedShimmer, useActivityOpen } from "./activity-disclosure";
import { activityIcon } from "./activity-icon";


export function ReasoningBlock({ block, presentation, active = block.streaming, collapsed, onCollapsedChange }: {
  readonly block: Extract<TimelineBlock, { type: "reasoning" }>;
  readonly presentation?: ReasoningContentPresentation;
  readonly active?: boolean;
  readonly collapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const document = useContext(ConversationDocumentContext);
  const intl = useIntl();
  const [localCollapsed, setLocalCollapsed] = useState(true);
  const selected = presentation ?? presentReasoning(block, active);
  const open = !(collapsed ?? localCollapsed);
  if (selected === null) return <></>;
  return <div className="thread-reasoning" data-conversation-row="activity" data-reasoning-id={block.id} data-reasoning-active={active}>
    <ActivityDisclosure
      icon={<ThinkingActivityIcon />}
      summary={active ? <ThinkingLabel /> : intl.formatMessage({ id: "chat.thought", defaultMessage: "Thought" })}
      detail={selected.header}
      running={active}
      open={open}
      onOpenChange={next => (onCollapsedChange ?? setLocalCollapsed)(!next)}
      unmountBodyWhenCollapsed
    >
      <div className="thread-activity-item__prose">
        <WebChatDocument documentId={`reasoning:${block.id}`} source={selected.content} streaming={active}
          conversationId={document.conversationId} hostId={document.hostId} cwd={document.cwd} theme={document.theme}
          onOpenResource={document.onOpenResource} loadMediaSource={document.loadMediaSource}
          onMeasurementRequest={document.onMeasurementRequest} />
      </div>
    </ActivityDisclosure>
  </div>;
}

/** Review artwork shares the shield and terminal language; the review owner supplies status. */
export function AutomaticApprovalReviewIcon() {
  return <ReviewShieldIcon aria-hidden="true" />;
}

function ReviewAssessment({ blockId, review }: { readonly blockId: string; readonly review: AutomaticApprovalReview }) {
  const [expanded, setExpanded] = useActivityOpen(false, false, JSON.stringify(["review-assessment", blockId, review.id]));
  const reduceMotion = useReducedMotion();
  const running = review.status === "inProgress";
  return <div className="thread-auto-review" data-status={review.status} data-warning={isAutomaticApprovalReviewWarning(review) || undefined}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <CadencedShimmer active={running}>{formatAutomaticApprovalReviewTitle(review)}</CadencedShimmer>
      <ChevronRight aria-hidden="true" size={12} />
    </button>
    <AnimatePresence initial={false}>
      {expanded ? <motion.p key="assessment" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.15 }}>
        {formatAutomaticApprovalReviewSummary(review)}
      </motion.p> : null}
    </AnimatePresence>
  </div>;
}

export function AutomaticApprovalReviewList({ blockId, reviews }: { readonly blockId: string; readonly reviews: readonly AutomaticApprovalReview[] }) {
  return <div className="thread-auto-review-list">{reviews.map(review => <ReviewAssessment key={review.id} blockId={blockId} review={review} />)}</div>;
}

export function AutomaticApprovalReviewBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "automatic-approval-review" }> }) {
  const review = block.review;
  const running = review.status === "inProgress";
  const [open, setOpen] = useActivityOpen(running, false, JSON.stringify(["review", block.id]));
  return <ActivityDisclosure icon={<AutomaticApprovalReviewIcon />} summary={summarizeAutomaticApprovalReviewAction(review.action)}
    running={running} status={running ? "running" : review.status === "denied" ? "failed" : review.status === "aborted" ? "interrupted" : "completed"}
    open={open} onOpenChange={setOpen}>
    <ReviewAssessment blockId={block.id} review={review} />
  </ActivityDisclosure>;
}

export function AutoReviewInterruptionWarningBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "auto-review-interruption-warning" }> }) {
  return <div className="thread-event-divider thread-auto-review-interruption"><span>
    <AutomaticApprovalReviewIcon />{block.message}<i aria-label={block.detail} title={block.detail}><AlertCircle aria-hidden="true" size={12} /></i>
  </span></div>;
}

/** Feedback belongs to the mounted action; clipboard policy stays in the shared port. */
function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  useEffect(() => () => {
    generation.current++;
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const perform = async (write: () => Promise<void>) => {
    const current = ++generation.current;
    try { await write(); } catch { return; }
    if (generation.current !== current) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setCopied(false); }, 1500);
  };
  return { copied, perform };
}

export function AssistantCopyButton({ value, getHtml, label }: {
  readonly value: string;
  readonly getHtml?: () => string | null;
  readonly label?: string;
}) {
  const intl = useIntl();
  const { copied, perform } = useCopyFeedback();
  const accessibleLabel = copied ? intl.formatMessage({ id: "common.copied", defaultMessage: "Copied" })
    : label ?? intl.formatMessage({ id: "chat.response.copy", defaultMessage: "Copy response" });
  return <button type="button" aria-label={accessibleLabel} title={accessibleLabel} onClick={() => void perform(() => {
    const html = getHtml?.();
    return html ? writeToClipboard({ "text/plain": value, "text/html": html }) : writeTextToClipboard(value);
  })}>{copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}</button>;
}

function TerminalCopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const { copied, perform } = useCopyFeedback();
  const intl = useIntl();
  const title = copied ? intl.formatMessage({ id: "common.copied", defaultMessage: "Copied" }) : label;
  return <button type="button" className={`thread-shell-output__copy ${copied ? "is-copied" : ""}`} title={title} aria-label={title}
    onClick={() => void perform(() => writeTextToClipboard(value))}>
    {copied ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
  </button>;
}

function CommandOutput({ block, running }: { readonly block: Extract<TimelineBlock, { type: "command-execution" }>; readonly running: boolean }) {
  const intl = useIntl();
  const views = useContext(CommandViewStateContext);
  const presentationActive = useWorkbenchPresentationActive();
  const output = normalizeTerminalOutput(block.output ?? "");
  const outputViewport = useRef<HTMLPreElement>(null);
  const followOutput = useRef(views?.get(block.id)?.followOutput ?? true);
  const restoredReading = useRef(false);
  const rememberReading = (viewport: HTMLPreElement) => {
    if (views) views.set(block.id, { open: views.get(block.id)?.open ?? true, scrollTop: viewport.scrollTop,
      scrollLeft: viewport.scrollLeft, followOutput: followOutput.current });
  };
  useLayoutEffect(() => {
    const viewport = outputViewport.current;
    // Hidden routes have zero geometry. Keep the View snapshot until the
    // original presentation owner resumes a measurable log.
    if (!presentationActive || !viewport?.clientHeight) {
      restoredReading.current = false;
      return;
    }
    if (!restoredReading.current) {
      const saved = views?.get(block.id);
      viewport.scrollLeft = saved?.scrollLeft ?? 0;
      if (!followOutput.current) viewport.scrollTop = saved?.scrollTop ?? 0;
      restoredReading.current = true;
    }
    if (followOutput.current) viewport.scrollTop = viewport.scrollHeight;
    rememberReading(viewport);
  }, [presentationActive, output]);
  useLayoutEffect(() => () => {
    // A route change can unmount before the browser dispatches its queued
    // scroll event. Save the live reading position before refs are detached.
    const viewport = outputViewport.current;
    if (!viewport?.clientHeight) return;
    followOutput.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
    rememberReading(viewport);
  }, [views, block.id]);
  const displayOutput = /\S/u.test(output) ? output
    : running ? "" : block.resultMissing
      ? intl.formatMessage({ id: "chat.command.outputUnavailable", defaultMessage: "Execution result unavailable" })
      : intl.formatMessage({ id: "chat.command.noOutput", defaultMessage: "No output" });
  return <div className="thread-shell-output" title={block.cwd === null ? undefined : `cwd\n${block.cwd}`}>
    <div className="thread-shell-output__command"><code><span aria-hidden="true">$ </span><span>{block.command}</span></code>
      <TerminalCopyButton value={block.command} label={intl.formatMessage({ id: "chat.command.copy", defaultMessage: "Copy command" })} />
    </div>
    <div className="thread-shell-output__output"><pre ref={outputViewport} onScroll={event => {
      const viewport = event.currentTarget;
      if (!presentationActive || !viewport.clientHeight) return;
      followOutput.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
      rememberReading(viewport);
    }}><code><AnsiTerminalText>{displayOutput}</AnsiTerminalText></code></pre>
      {output ? <TerminalCopyButton value={output} label={intl.formatMessage({ id: "chat.output.copy", defaultMessage: "Copy output" })} /> : null}
    </div>
    {!running ? <div className="thread-shell-output__footer" data-status={block.status}><span>
      {block.resultMissing ? intl.formatMessage({ id: "chat.command.resultUnknown", defaultMessage: "Result unknown" })
        : block.status === "interrupted" ? intl.formatMessage({ id: "chat.command.stopped", defaultMessage: "Stopped" })
        : block.exitCode === 0 ? <><Check aria-hidden="true" size={12} /> {intl.formatMessage({ id: "chat.command.success", defaultMessage: "Success" })}</>
        : block.exitCode === null ? intl.formatMessage({ id: "chat.command.exitUnknown", defaultMessage: "Exit code unknown" })
        : intl.formatMessage({ id: "chat.command.exitCode", defaultMessage: "Exit code {code}" }, { code: block.exitCode })}
    </span></div> : null}
  </div>;
}

function useCommandElapsed(block: Extract<TimelineBlock, { type: "command-execution" }>, running: boolean) {
  const active = useWorkbenchPresentationActive();
  const observedStart = useRef<number | null>(null);
  if (running && observedStart.current === null) observedStart.current = Date.now();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !active || !block.turnInProgress) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, running, block.turnInProgress, block.startedAtMs]);
  return running ? Math.max(0, now - (block.startedAtMs ?? observedStart.current ?? now)) : block.durationMs;
}

export function CommandBlock({ block }: { block: Extract<TimelineBlock, { type: "command-execution" }> }) {
  const presentation = useToolActivityPresentation(block);
  const detailLevel = useContext(ConversationDetailContext);
  const document = useContext(ConversationDocumentContext);
  const intl = useIntl();
  const views = useContext(CommandViewStateContext);
  const [open, setLocalOpen] = useState(() => views?.get(block.id)?.open ?? false);
  const setOpen = (next: boolean) => {
    // An explicit reopen starts at the latest output, as before. A remount
    // restores the reader's saved position and follow intent instead.
    views?.set(block.id, { open: next, scrollTop: 0, scrollLeft: 0, followOutput: true });
    setLocalOpen(next);
  };
  useHistoryItemDetail(block, open);
  const running = presentation.state === "running";
  const elapsed = useCommandElapsed(block, running);
  const skill = skillReadPresentation(block, detailLevel);
  const read = block.actions.length === 1 && block.actions[0]?.type === "read" ? block.actions[0] : null;
  let detail: ReactNode = skill?.detail ?? presentation.detail;
  if (skill === null && read !== null && document.onOpenResource !== undefined) {
    const decision = resolveStandardChatResource(read.path || read.name, { cwd: document.cwd ?? block.cwd, externalResourcePolicy: "allow" });
    if (decision.allowed && decision.target !== null) detail = <button type="button" className="thread-activity-item__file-link"
      onClick={() => document.onOpenResource?.(decision.target!, decision)}>{presentation.detail ?? read.name}</button>;
  }
  const semanticAction = block.actions.length === 1 && block.actions[0]?.type !== "unknown";
  const isTerminal = !semanticAction;
  const label = isTerminal ? formatCommandActivitySummary(block, presentation.state, { expanded: open,
    elapsedLabel: elapsed === null ? null : formatToolDuration(elapsed, intl.locale) }) : skill?.summary ?? presentation.summary;
  if (skill?.visible === false) return <></>;
  return <ActivityDisclosure icon={activityIcon(presentation.icon)} summary={label} detail={detail}
    running={running} status={presentation.state} open={open} onOpenChange={setOpen} unmountBodyWhenCollapsed
    accessory={block.automaticApprovalReviews.length ? <AutomaticApprovalReviewIcon /> : undefined}>
    {(isTerminal && presentation.canExpand) || block.automaticApprovalReviews.length > 0 ? <>
      {isTerminal && presentation.canExpand ? <CommandOutput block={block} running={running} /> : null}
      {block.automaticApprovalReviews.length ? <AutomaticApprovalReviewList blockId={block.id} reviews={block.automaticApprovalReviews} /> : null}
    </> : null}
  </ActivityDisclosure>;
}
