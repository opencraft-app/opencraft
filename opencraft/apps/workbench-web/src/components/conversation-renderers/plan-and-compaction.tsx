import {
  compactionLabel,
  todoSummary,
  type TimelineBlock,
} from "@opencraft/chat-core";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { ChevronDown, Download, ListChecks } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConversationDocumentContext } from "../conversation/document-context";
import { CadencedShimmer } from "./activity/activity-disclosure";
import { AssistantCopyButton } from "./activity/command-and-review-renderers";

export function PlanBlock({
  block,
}: {
  block: Extract<TimelineBlock, { type: "plan" }>;
}) {
  const document = useContext(ConversationDocumentContext);
  const [collapsed, setCollapsed] = useState(!block.completed);
  const reducedMotion = useReducedMotion();
  const canCopy = block.completed && block.text.trim().length > 0;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([block.text], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = "plan.md";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <section className="thread-plan" data-plan-completed={block.completed}>
      <header>
        <strong>
          <CadencedShimmer active={!block.completed}>
            {block.completed ? (block.title ?? "Plan") : "Writing plan"}
          </CadencedShimmer>
        </strong>
        <div>
          {canCopy ? (
            <>
              <button
                aria-label="Download plan"
                onClick={download}
                type="button"
              >
                <Download size={12} />
              </button>
            <AssistantCopyButton value={block.text} label="Copy plan" />
            </>
          ) : null}
          <button
            aria-label={
              collapsed ? "Expand plan summary" : "Collapse plan summary"
            }
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
            type="button"
          >
            <ChevronDown
              size={12}
              style={{ transform: collapsed ? undefined : "rotate(180deg)" }}
            />
          </button>
        </div>
      </header>
      <motion.div
        className="thread-plan__body"
        initial={false}
        animate={{ height: collapsed ? 320 : "auto" }}
        transition={{
          duration: reducedMotion ? 0 : 0.3,
          ease: [0.19, 1, 0.22, 1],
        }}
      >
        <WebChatDocument
          documentId={block.id}
          source={block.text}
          streaming={!block.completed}
          conversationId={document.conversationId}
          hostId={document.hostId}
          cwd={document.cwd}
          theme={document.theme}
          onOpenResource={document.onOpenResource}
          loadMediaSource={document.loadMediaSource}
        />
        {collapsed ? (
          <div className="thread-plan__expand">
            <button type="button" onClick={() => setCollapsed(false)}>
              Expand plan
            </button>
          </div>
        ) : null}
      </motion.div>
    </section>
  );
}

export function TodoBlock({
  block,
}: {
  block: Extract<TimelineBlock, { type: "todo" }>;
}) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const cancelDismiss = () => {
    if (dismiss.current !== null) clearTimeout(dismiss.current);
  };
  const show = () => {
    cancelDismiss();
    popup.current?.showPopover();
  };
  const toggle = () => {
    cancelDismiss();
    const element = popup.current;
    if (!element) return;
    if (element.matches(":popover-open")) element.hidePopover();
    else element.showPopover();
  };
  const scheduleDismiss = () => {
    cancelDismiss();
    dismiss.current = setTimeout(() => popup.current?.hidePopover(), 120);
  };
  useEffect(
    () => () => {
      if (dismiss.current !== null) clearTimeout(dismiss.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = anchor.current;
      const element = popup.current;
      if (!trigger || !element) return;
      const rect = trigger.getBoundingClientRect();
      const height = element.getBoundingClientRect().height;
      element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, rect.top >= height + 16 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (popup.current) observer.observe(popup.current);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);
  if (block.entries.length === 0)
    return <span className="thread-todo__empty" />;
  const completed = block.entries.filter(
    (entry) => entry.status === "complete",
  ).length;
  return (
    <div className="thread-todo">
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        onMouseEnter={show}
        onMouseLeave={scheduleDismiss}
        onFocus={show}
        onBlur={scheduleDismiss}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.2"
          />
          <motion.circle
            cx="8"
            cy="8"
            r="6"
            pathLength="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="1"
            initial={{ strokeDashoffset: 1 }}
            animate={{ strokeDashoffset: 1 - completed / block.entries.length }}
            transition={{ duration: reducedMotion ? 0 : 0.3 }}
            transform="rotate(-90 8 8)"
          />
        </svg>
        {todoSummary(block)}
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="region"
        aria-label="Plan steps"
        className="thread-todo__popup"
        style={{ visibility: open ? undefined : "hidden" }}
        onToggle={(event) => setOpen(event.newState === "open")}
        onMouseEnter={cancelDismiss}
        onMouseLeave={scheduleDismiss}
        onFocus={cancelDismiss}
        onBlur={scheduleDismiss}
      >
        <ul>
          {block.entries.map((entry) => (
            <li key={entry.id} data-status={entry.status}>
              <TodoEntryGlyph status={entry.status} />
              <span>
                <CadencedShimmer active={entry.status === "in-progress"}>
                  {entry.text}
                </CadencedShimmer>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TodoEntryGlyph({ status }: { status: Extract<TimelineBlock, { type: "todo" }>["entries"][number]["status"] }) {
  const gradientId = useId();
  if (status === "complete") return (
    <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
      <circle cx="7" cy="7" fill="none" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.4 7.2 5.8 9.4 10.7 4.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
    </svg>
  );
  if (status === "in-progress") return (
    <svg aria-hidden="true" className="thread-todo__progress-glyph" height="14" viewBox="0 0 14 14" width="14">
      <defs><linearGradient id={gradientId} x1="2.5" x2="10.5" y1="12" y2="3.5"><stop stopColor="currentColor" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <circle cx="7" cy="7" fill="none" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  );
  return (
    <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
      <circle cx="7" cy="7" fill="none" r="6.4" stroke="currentColor" strokeDasharray="2.4 2.4" strokeWidth="1.2" />
    </svg>
  );
}

export function CompactionBlock({
  block,
}: {
  block: Extract<TimelineBlock, { type: "compaction" }>;
}) {
  return (
    <div className="thread-compaction" data-completed={block.completed}>
      <ListChecks size={12} />
      <CadencedShimmer active={!block.completed}>
        {compactionLabel(block)}
      </CadencedShimmer>
    </div>
  );
}
