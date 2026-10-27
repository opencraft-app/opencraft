import { TimelineProgressIcon, TimelineStatusIcon } from "@opencraft/design-system-web/timeline-icons";
import { ChevronDownIcon as ChevronDown } from "@opencraft/design-system-web/action-icons";
import * as Popover from "@radix-ui/react-popover";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";
import { useIntl } from "@opencraft/i18n/react";
import {
  compactionLabel,
  todoSummary,
  type TimelineBlock,
} from "@opencraft/chat-core";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { observeBorderBoxHeight } from "@opencraft/timeline-host-web";
import { DownloadIcon as Download, ChecklistIcon as ListChecks } from "@opencraft/design-system-web/action-icons";
import { motion, useReducedMotion } from "motion/react";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConversationDocumentContext } from "../conversation/document-context";
import { CadencedShimmer, useActivityOpen } from "./activity/activity-disclosure";
import { ActivitySummaryRow } from "./activity/activity-summary-row";
import { AssistantCopyButton } from "./activity/command-and-review-renderers";

const PLAN_PREVIEW_HEIGHT_PX = 320;

export function PlanBlock({
  block,
}: {
  block: Extract<TimelineBlock, { type: "plan" }>;
}) {
  const intl = useIntl();
  const document = useContext(ConversationDocumentContext);
  const [expanded, setExpanded] = useActivityOpen(false, block.completed, JSON.stringify(["plan", block.id]));
  const collapsed = !expanded;
  const contentRef = useRef<HTMLDivElement>(null);
  const [previewClipped, setPreviewClipped] = useState(false);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null) return;
    return observeBorderBoxHeight(element, (height) => setPreviewClipped(height > PLAN_PREVIEW_HEIGHT_PX));
  }, []);
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
            <AssistantCopyButton value={block.text} label={intl.formatMessage({ id: "chat.plan.copy", defaultMessage: "Copy plan" })} />
            </>
          ) : null}
          <button
            aria-label={
              collapsed ? "Expand plan summary" : "Collapse plan summary"
            }
            aria-expanded={!collapsed}
            onClick={() => setExpanded(collapsed)}
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
        animate={{ height: collapsed ? PLAN_PREVIEW_HEIGHT_PX : "auto" }}
        transition={{
          duration: reducedMotion ? 0 : 0.3,
          ease: [0.19, 1, 0.22, 1],
        }}
      >
        <div className="thread-plan__content" ref={contentRef}>
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
        </div>
        {collapsed && previewClipped ? (
          <div className="thread-plan__expand">
            <button type="button" onClick={() => setExpanded(true)}>
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
  const portal = useWorkbenchPresentationRoot();
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const cancelDismiss = () => {
    if (dismiss.current !== null) clearTimeout(dismiss.current);
  };
  const scheduleDismiss = () => {
    cancelDismiss();
    dismiss.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => {
    if (dismiss.current !== null) clearTimeout(dismiss.current);
  }, []);
  if (block.entries.length === 0)
    return <span className="thread-todo__empty" />;
  const completed = block.entries.filter(
    (entry) => entry.status === "complete",
  ).length;
  return (
    <Popover.Root open={open} onOpenChange={next => { cancelDismiss(); setOpen(next); }}>
      <div className="thread-todo">
      <Popover.Trigger asChild>
      <button
        type="button"
        onPointerEnter={event => { if (event.pointerType === "mouse") { cancelDismiss(); setOpen(true); } }}
        onPointerLeave={event => { if (event.pointerType === "mouse") scheduleDismiss(); }}
      >
        <TimelineProgressIcon completed={completed} total={block.entries.length} reducedMotion={!!reducedMotion} />
        {todoSummary(block)}
      </button>
      </Popover.Trigger>
      </div>
      <Popover.Portal container={portal}>
      <Popover.Content
        aria-label="Plan steps"
        className="thread-todo__popup"
        side="top" align="start" sideOffset={8} collisionPadding={8}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onMouseEnter={cancelDismiss}
        onMouseLeave={scheduleDismiss}
        onFocus={cancelDismiss}
      >
        <ul>
          {block.entries.map((entry) => (
            <li key={entry.id} data-status={entry.status}>
              <TimelineStatusIcon status={entry.status} />
              <span>
                <CadencedShimmer active={entry.status === "in-progress"}>
                  {entry.text}
                </CadencedShimmer>
              </span>
            </li>
          ))}
        </ul>
      </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function CompactionBlock({
  block,
}: {
  block: Extract<TimelineBlock, { type: "compaction" }>;
}) {
  return (
    <div className="thread-compaction" data-completed={block.completed}>
      <ActivitySummaryRow icon={<ListChecks />} running={!block.completed} summary={compactionLabel(block)} />
    </div>
  );
}
