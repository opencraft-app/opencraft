import {
  formatAutomaticApprovalReviewSummary,
  formatAutomaticApprovalReviewTitle,
  formatCodexToolDuration,
  formatCommandActivitySummary,
  isAutomaticApprovalReviewWarning,
  summarizeAutomaticApprovalReviewAction,
  skillReadPresentation,
  type AutomaticApprovalReview,
  type TimelineBlock,
} from "@opencraft/chat-core";
import {
  AnsiTerminalText,
  normalizeTerminalOutput,
  resolveStandardChatResource,
  writeTextToClipboard,
  writeToClipboard,
} from "@opencraft/chat-render-web";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Wrench,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ConversationDocumentContext } from "../../conversation/document-context";
import { activityIcon } from "./activity-icon";
import {
  ActivityDisclosure,
  CadencedShimmer,
  useCodexActivityOpen,
} from "./activity-disclosure";
import { useToolActivityPresentation, ConversationDetailContext } from "../render-contexts";

function ReasoningBlock({ block }: { block: Extract<TimelineBlock, { type: "reasoning" }> }) {
  const [open, setOpen] = useCodexActivityOpen(block.streaming);
  const detail = block.detail || null;
  return (
    <ActivityDisclosure
      icon={<Bot size={14} />}
      onOpenChange={setOpen}
      open={open}
      running={block.streaming}
      summary={block.streaming ? (block.summary || "Thinking") : (block.summary || "Thought")}
    >
      {detail ? <p className="thread-activity-item__prose">{detail}</p> : null}
    </ActivityDisclosure>
  );
}

function useCommandElapsedLabel(
  block: Extract<TimelineBlock, { type: "command-execution" }>,
  running: boolean,
): string | null {
  const fallbackStartedAt = useRef<number | null>(null);
  if (fallbackStartedAt.current === null && running) fallbackStartedAt.current = Date.now();
  const [nowMs, setNowMs] = useState(Date.now);
  const backgroundRunning = running && !block.turnInProgress;
  useEffect(() => {
    if (!running || backgroundRunning) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [backgroundRunning, running]);
  const durationMs = running
    ? Math.max(0, nowMs - (block.startedAtMs ?? fallbackStartedAt.current ?? nowMs))
    : Math.max(0, block.durationMs ?? 0);
  return formatCodexToolDuration(durationMs);
}

/** Source-identical Codex automatic-review accessory: terminal prompt inside a shield. */
function AutomaticApprovalReviewIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.35645 8.36286C7.70789 8.01161 8.27846 8.01156 8.62988 8.36286L10.6299 10.3629C10.9813 10.7143 10.9812 11.2848 10.6299 11.6363L8.62988 13.6363C8.27841 13.9878 7.70792 13.9878 7.35645 13.6363C7.00509 13.2848 7.00501 12.7143 7.35645 12.3629L8.71973 10.9996L7.35645 9.6363C7.00509 9.28482 7.00501 8.71429 7.35645 8.36286Z" fill="currentColor" />
      <path d="M15.9932 12.0992C16.4901 12.0993 16.8934 12.5027 16.8936 12.9996C16.8936 13.4966 16.4902 13.8999 15.9932 13.9H12.9932C12.4961 13.9 12.0928 13.4966 12.0928 12.9996C12.0929 12.5027 12.4962 12.0992 12.9932 12.0992H15.9932Z" fill="currentColor" />
      <path clipRule="evenodd" d="M10.8398 1.25056C11.5807 0.926648 12.4233 0.926498 13.1641 1.25056L19.1553 3.87165C20.2108 4.33346 20.8925 5.37677 20.8926 6.52888V12.2252C20.8925 14.9571 19.9307 17.0944 18.3848 18.732C16.8587 20.3484 14.7999 21.442 12.6426 22.1939L12.6357 22.1959C12.2285 22.3338 11.787 22.3286 11.3828 22.1832C11.376 22.1808 11.3691 22.1797 11.3623 22.1773C9.20761 21.4308 7.1513 20.3432 5.625 18.734C4.07352 17.0981 3.10656 14.9601 3.10645 12.2252V6.52888C3.10658 5.37681 3.78925 4.33437 4.84473 3.87263L10.8398 1.25056ZM12.4424 2.89997C12.1614 2.77709 11.8415 2.7771 11.5605 2.89997L5.56641 5.52106C5.16607 5.69616 4.90736 6.09194 4.90723 6.52888V12.2252C4.90734 14.4896 5.69001 16.1864 6.93066 17.4947C8.11301 18.7413 9.74347 19.6681 11.5967 20.3502L11.9707 20.483L11.9805 20.4869L11.9912 20.4898C12.0126 20.4978 12.0359 20.4981 12.0576 20.4908C14.0571 19.793 15.8197 18.8263 17.0752 17.4966C18.312 16.1866 19.0927 14.4887 19.0928 12.2252V6.52888C19.0927 6.09191 18.8339 5.69623 18.4336 5.52106L12.4424 2.89997Z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

function automaticApprovalReviewActivityStatus(
  review: AutomaticApprovalReview,
): "running" | "completed" | "failed" | "interrupted" {
  if (review.status === "inProgress") return "running";
  if (review.status === "denied") return "failed";
  if (review.status === "aborted") return "interrupted";
  return "completed";
}

function AutomaticApprovalReviewRow({ review }: { readonly review: AutomaticApprovalReview }) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const warning = isAutomaticApprovalReviewWarning(review);
  const title = formatAutomaticApprovalReviewTitle(review);
  const summary = formatAutomaticApprovalReviewSummary(review);
  return (
    <div className="thread-auto-review" data-status={review.status} data-warning={warning || undefined}>
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)} type="button">
        <CadencedShimmer active={review.status === "inProgress"}>{title}</CadencedShimmer>
        <ChevronRight aria-hidden="true" size={12} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.p
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.19, 1, 0.22, 1] }}
          >{summary}</motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function AutomaticApprovalReviewList({ reviews }: { readonly reviews: readonly AutomaticApprovalReview[] }) {
  if (reviews.length === 0) return null;
  return <div className="thread-auto-review-list">{reviews.map((review) => <AutomaticApprovalReviewRow key={review.id} review={review} />)}</div>;
}

function AutomaticApprovalReviewBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "automatic-approval-review" }> }) {
  const review = block.review;
  const running = review.status === "inProgress";
  const [open, setOpen] = useCodexActivityOpen(running);
  return (
    <ActivityDisclosure
      icon={<Wrench size={14} />}
      onOpenChange={setOpen}
      open={open}
      running={running}
      status={automaticApprovalReviewActivityStatus(review)}
      summary={summarizeAutomaticApprovalReviewAction(review.action)}
    >
      <AutomaticApprovalReviewRow review={review} />
    </ActivityDisclosure>
  );
}

function AutoReviewInterruptionWarningBlock({ block }: { readonly block: Extract<TimelineBlock, { type: "auto-review-interruption-warning" }> }) {
  return (
    <div className="thread-event-divider thread-auto-review-interruption">
      <span><Wrench aria-hidden="true" size={13} />{block.message}<i aria-label={block.detail} title={block.detail}><AlertCircle aria-hidden="true" size={12} /></i></span>
    </div>
  );
}

function unwrapShellCommand(value: string): string {
  const stripOuterQuotes = (source: string): string => {
    let result = source.trim().replace(/^\$\s+/u, "");
    let changed = true;
    while (changed) {
      changed = false;
      if ((result.startsWith("'") && result.endsWith("'")) || (result.startsWith('"') && result.endsWith('"'))) {
        result = result.slice(1, -1).trim();
        changed = true;
      }
    }
    return result.replace(/'"'"'/gu, "'").trim();
  };
  const normalized = stripOuterQuotes(value);
  const wrapper = normalized.match(/^(?:\/bin\/zsh|\/bin\/bash|zsh|bash)\s+-lc\s+([\s\S]+)$/u);
  return stripOuterQuotes(wrapper?.[1] ?? normalized);
}

function ShellCopyButton({ className = "", label, value }: { readonly className?: string; readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);
  const copy = useCallback(() => {
    void writeTextToClipboard(value).then(() => {
      setCopied(true);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => setCopied(false));
  }, [value]);
  return (
    <button aria-label={copied ? "Copied" : label} className={`thread-shell-output__copy ${className}`} onClick={copy} title={copied ? "Copied" : label} type="button">
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function AssistantCopyButton({ value, getHtml, label = "Copy response" }: { readonly value: string; readonly getHtml?: () => string | null; readonly label?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);
  const copy = useCallback(() => {
    const html = getHtml?.();
    void writeToClipboard(html ? { "text/plain": value, "text/html": html } : value).then(() => {
      setCopied(true);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => setCopied(false));
  }, [value, getHtml]);
  return (
    <button aria-label={copied ? "Copied" : label} onClick={copy} title={copied ? "Copied" : label} type="button">
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function EmbeddedShellOutput({ block }: { block: Extract<TimelineBlock, { type: "command-execution" }> }) {
  const running = block.status === "pending" || block.status === "running";
  const command = unwrapShellCommand(block.command);
  const output = normalizeTerminalOutput(block.output ?? "");
  const displayOutput = /\S/u.test(output) ? output : running ? "" : block.resultMissing ? "Execution result unavailable" : "No output";
  const outputRef = useRef<HTMLPreElement>(null);
  const followsOutputRef = useRef(true);
  const updateFollowIntent = useCallback(() => {
    const element = outputRef.current;
    if (element === null) return;
    followsOutputRef.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
  }, []);
  useLayoutEffect(() => {
    const element = outputRef.current;
    if (element !== null && followsOutputRef.current) element.scrollTop = element.scrollHeight;
  }, [displayOutput]);
  const footer = running ? null
    : block.resultMissing ? <span>Result unknown</span>
    : block.status === "interrupted" ? <span>Stopped</span>
    : block.exitCode === 0 ? <span><Check size={11} /> Success</span>
    : <span>Exit code {block.exitCode ?? "unknown"}</span>;
  return (
    <div className="thread-shell-output" title={block.cwd === null ? undefined : `cwd\n${block.cwd}`}>
      {command.trim().length > 0 ? (
        <div className="thread-shell-output__command">
          <code><span aria-hidden="true">$ </span><AnsiTerminalText>{command}</AnsiTerminalText></code>
          <ShellCopyButton label="Copy command" value={command} />
        </div>
      ) : null}
      <div className="thread-shell-output__output">
        <pre onScroll={updateFollowIntent} ref={outputRef}><code><AnsiTerminalText>{displayOutput}</AnsiTerminalText></code></pre>
        {output.length > 0 ? <ShellCopyButton label="Copy output" value={output} /> : null}
      </div>
      <div className="thread-shell-output__footer" data-status={block.status}>{footer}</div>
    </div>
  );
}

function CommandBlock({ block }: { block: Extract<TimelineBlock, { type: "command-execution" }> }) {
  const presentation = useToolActivityPresentation(block);
  const detailLevel = useContext(ConversationDetailContext);
  const skill = skillReadPresentation(block, detailLevel);
  const documentContext = useContext(ConversationDocumentContext);
  // ExecShellContainer owns one persistent disclosure state. Unlike generic
  // Activity rows, a running command starts collapsed and does not switch to
  // separate live/settled memories when it completes.
  const [open, setOpen] = useState(false);
  const elapsedLabel = useCommandElapsedLabel(block, presentation.state === "running");
  const action = block.actions.length === 1 ? block.actions[0] : undefined;
  const semanticAction = action !== undefined && action.type !== "unknown";
  const summary = skill?.summary ?? (semanticAction
    ? presentation.summary
    : formatCommandActivitySummary(block, presentation.state, { expanded: open, elapsedLabel }));
  const detail = skill?.detail ?? (action?.type === "read" && action.path.trim().length > 0 ? (
    <button
      className="thread-activity-item__file-link"
      onClick={(event) => {
        event.stopPropagation();
        const decision = resolveStandardChatResource(action.path, {
          cwd: documentContext.cwd,
          externalResourcePolicy: "allow",
        });
        if (decision.allowed && decision.target !== null) {
          documentContext.onOpenResource?.(decision.target, decision);
        }
      }}
      type="button"
    >{presentation.detail ?? action.path}</button>
  ) : semanticAction ? presentation.detail : null);
  const hasAuxiliaryBody = block.automaticApprovalReviews.length > 0;
  if (skill?.visible === false) return null;
  return (
    <ActivityDisclosure
      accessory={block.automaticApprovalReviews.length > 0 ? <AutomaticApprovalReviewIcon /> : null}
      detail={detail}
      icon={activityIcon(presentation.icon)}
      onOpenChange={setOpen}
      open={open}
      running={presentation.state === "running"}
      status={presentation.state}
      summary={summary}
      unmountBodyWhenCollapsed
    >
      {(!semanticAction && presentation.canExpand) || hasAuxiliaryBody ? (
        <>
          {!semanticAction && presentation.canExpand ? <EmbeddedShellOutput block={block} /> : null}
          <AutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
        </>
      ) : null}
    </ActivityDisclosure>
  );
}


export {
  AssistantCopyButton,
  AutomaticApprovalReviewBlock,
  AutomaticApprovalReviewIcon,
  AutomaticApprovalReviewList,
  AutoReviewInterruptionWarningBlock,
  CommandBlock,
  ReasoningBlock,
};
