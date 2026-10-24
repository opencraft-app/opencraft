import { ChevronDownIcon as ChevronDown } from "@opencraft/design-system-web/action-icons";
import type { TimelineSnapshot, TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { resolveStandardChatResource } from "@opencraft/chat-render-web";
import { useIntl } from "@opencraft/i18n/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ArrowRightIcon as ArrowRight } from "@opencraft/design-system-web/action-icons";
import { motion, useReducedMotion } from "motion/react";
import { useContext, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { ChangeResourceIcon } from "../activity-glyphs";
import { UnifiedDiffPreview } from "../conversation-renderers/unified-diff-preview";
import { useActivityOpen } from "../conversation-renderers/activity/activity-disclosure";
import { Button } from "../ui/button";
import { useDisclosureReflow } from "../use-disclosure-reflow";
import { ConversationDocumentContext, type ConversationDocumentContextValue } from "./document-context";
import { ConversationEntryMotionContext } from "./entry-motion";
import { indexReviewFileDiffs } from "./turn-diff-review";

const COLLAPSED_FILE_COUNT = 3;
const INLINE_DIFF_MAX_LINES = 5_000;
const DIGITS = Array.from({ length: 10 }, (_, digit) => digit);

/** One live entry follows the actual Composer, including its floating placement.
 * Transcript and mini-transcript consumers suppress this exact Turn's duplicate.
 */
export function ComposerTurnChangeSummary({ timeline, turnId, documentContext }: {
  readonly timeline: TimelineSnapshot | null;
  readonly turnId: string | null;
  readonly documentContext: ConversationDocumentContextValue;
}) {
  const block = turnId === null ? null : timeline?.frames.find((frame) => frame.turnId === turnId && frame.changeSummary != null)?.changeSummary;
  if (block == null || block.files.length === 0 || (block.status !== "pending" && block.status !== "running")) return null;
  return <ConversationDocumentContext.Provider value={documentContext}>
    <div className="thread-live-changes" data-turn-resource-id={block.id}><TurnDiffBlock block={block} key={block.id} /></div>
  </ConversationDocumentContext.Provider>;
}

function displayPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? { basename: normalized, directory: "" }
    : { basename: normalized.slice(separator + 1), directory: normalized.slice(0, separator + 1) };
}

function DiffNumber({ value, animated }: { readonly value: number; readonly animated: boolean }) {
  const intl = useIntl();
  const formatted = intl.formatNumber(value);
  if (!animated) return <>{formatted}</>;
  // Stable columns from the units place let new digits enter without remounting
  // the existing columns. Only their transform changes, never the resource ID.
  const characters = Array.from(formatted);
  return <span aria-label={formatted} className="thread-turn-diff__number">{characters.map((character, index) => (
    /[0-9]/u.test(character)
      ? <span aria-hidden="true" className="thread-turn-diff__digit" key={characters.length - index}>
        <span style={{ transform: `translateY(calc(-${character} * 1lh))` }}>{DIGITS.map((digit) => <span key={digit}>{digit}</span>)}</span>
      </span>
      : <span aria-hidden="true" key={`separator-${characters.length - index}`}>{character}</span>
  ))}</span>;
}

function DiffStats({ additions, deletions, animated = false }: {
  readonly additions: number; readonly deletions: number; readonly animated?: boolean;
}) {
  const intl = useIntl();
  return <span className="thread-turn-diff__stats" data-thread-find-skip="true"
    aria-label={intl.formatMessage({ id: "chat.changes.counts", defaultMessage: "{added} lines added, {removed} lines removed" }, { added: additions, removed: deletions })}>
    <b>+<DiffNumber value={additions} animated={animated} /></b>
    <i>-<DiffNumber value={deletions} animated={animated} /></i>
  </span>;
}

function DiffHover({ children, diff, path, additions, deletions }: {
  readonly children: ReactElement; readonly diff: string; readonly path: string;
  readonly additions: number; readonly deletions: number;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const canPreview = useMemo(() => /^@@ /mu.test(diff)
    && Math.max(diff.split("\n").length, additions + deletions) <= INLINE_DIFF_MAX_LINES, [diff, additions, deletions]);
  if (!canPreview) return children;
  return <Tooltip.Root delayDuration={800} open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content aria-label={intl.formatMessage({ id: "chat.changes.preview", defaultMessage: "Change preview" })} className="thread-turn-diff-preview" side="top" sideOffset={0}>
      <div className="thread-turn-diff-preview__heading"><span title={path}>{displayPath(path).basename}</span>
        <DiffStats additions={additions} deletions={deletions} />
      </div>
      {open ? <UnifiedDiffPreview diff={diff} /> : null}
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>;
}

/** A Turn resource, never a message, disclosure boundary, or execution owner. */
export function TurnDiffBlock({ block }: { readonly block: TurnDiffTimelineBlock }) {
  const intl = useIntl();
  const document = useContext(ConversationDocumentContext);
  const [expanded, setExpanded] = useActivityOpen(false, false, `turn-files:${block.id}`);
  const [livePreviewOpen, setLivePreviewOpen] = useState(false);
  const liveListRef = useRef<HTMLDivElement>(null);
  const reflow = useDisclosureReflow();
  const reducedMotion = useReducedMotion();
  const allowEntryMotion = useContext(ConversationEntryMotionContext);
  useLayoutEffect(() => reflow.complete(), [expanded, reflow.complete]);
  const inProgress = block.status === "pending" || block.status === "running";
  const files = expanded ? block.files : block.files.slice(0, COLLAPSED_FILE_COUNT);
  const fileDiffs = useMemo(() => inProgress ? new Map<string, string>() : indexReviewFileDiffs(block.unifiedDiff), [inProgress, block.unifiedDiff]);
  const viewChanges = intl.formatMessage({ id: "chat.changes.view", defaultMessage: "View changes" });
  const canReview = document.onReviewTurnDiff !== undefined;
  const canOpenFile = canReview || document.onOpenResource !== undefined;
  const open = (event: MouseEvent<HTMLButtonElement>, path?: string) => {
    if (path !== undefined && (!canReview || ((event.metaKey || event.ctrlKey) && document.onOpenResource !== undefined))) {
      const decision = resolveStandardChatResource(path, { cwd: document.cwd, externalResourcePolicy: "allow" });
      if (decision.allowed && decision.target !== null) document.onOpenResource?.(decision.target, decision);
    } else document.onReviewTurnDiff?.(block, path);
  };
  if (block.files.length === 0) return null;
  if (inProgress) return <Tooltip.Provider><Tooltip.Root open={livePreviewOpen} onOpenChange={setLivePreviewOpen}>
    <Tooltip.Trigger asChild><motion.button animate={{ opacity: 1, y: 0 }} initial={reducedMotion || !allowEntryMotion ? false : { opacity: 0, y: 4 }}
      transition={{ duration: reducedMotion ? 0 : 0.15, ease: "easeOut" }} className="thread-turn-diff-live" disabled={!canReview}
      aria-keyshortcuts="ArrowDown"
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault(); setLivePreviewOpen(true);
        requestAnimationFrame(() => liveListRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
      }}
      onBlur={(event) => { if (event.relatedTarget instanceof Node && liveListRef.current?.contains(event.relatedTarget)) event.preventDefault(); }}
      onClick={(event) => { setLivePreviewOpen(false); open(event); }} type="button">
      <span>{intl.formatMessage({ id: "chat.changes.live", defaultMessage: "{count, plural, one {# file changed} other {# files changed}}" }, { count: block.files.length })}</span>
      <DiffStats additions={block.additions} deletions={block.deletions} animated />
    </motion.button></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content aria-label={intl.formatMessage({ id: "chat.changes.viewFiles", defaultMessage: "View changed files" })}
      className="thread-turn-diff-file-list" side="top" sideOffset={4} ref={liveListRef}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setLivePreviewOpen(false); }}>
      <ul>{block.files.map((file) => <li key={file.path}><button disabled={!canOpenFile} type="button"
        aria-label={intl.formatMessage({ id: "chat.changes.openFile", defaultMessage: "Open {path}" }, { path: file.path })}
        onClick={(event) => { setLivePreviewOpen(false); open(event, file.path); }}>
        <span>{displayPath(file.path).basename}</span><DiffStats additions={file.additions} deletions={file.deletions} />
      </button></li>)}</ul>
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root></Tooltip.Provider>;

  const single = block.files.length === 1 ? block.files[0]! : null;
  const headerTarget = <button aria-label={intl.formatMessage({ id: "chat.changes.viewFiles", defaultMessage: "View changed files" })}
    className="thread-turn-diff__header-target" disabled={!canReview} onClick={(event) => open(event, single?.path)} type="button" />;
  return <Tooltip.Provider><section className="thread-turn-diff" data-status={block.status}>
    <div className="thread-turn-diff__header">
      {single === null ? headerTarget : <DiffHover path={single.path} diff={block.unifiedDiff} additions={single.additions} deletions={single.deletions}>{headerTarget}</DiffHover>}
      <span className="thread-turn-diff__icon"><ChangeResourceIcon aria-hidden="true" /></span>
      <span className="thread-turn-diff__copy"><strong>{single === null
        ? intl.formatMessage({ id: "chat.changes.editedFiles", defaultMessage: "{count, plural, one {Edited a file} other {Edited # files}}" }, { count: block.files.length })
        : intl.formatMessage({ id: "chat.changes.editedFile", defaultMessage: "Edited {filename}" }, { filename: displayPath(single.path).basename })}</strong>
        <span className="thread-turn-diff__subtitle">
          <span className="thread-turn-diff__default-subtitle"><DiffStats additions={block.additions} deletions={block.deletions} /></span>
          <span className="thread-turn-diff__hover-subtitle">{viewChanges}<ArrowRight aria-hidden="true" size={12} /></span>
        </span>
      </span>
      <span className="thread-turn-diff__actions">{canReview ? <Button size="toolbar" variant="outline" onClick={(event) => open(event, single?.path)}>{viewChanges}</Button> : null}</span>
    </div>
    {block.files.length > 1 ? <div className="thread-turn-diff__files">{files.map((file) => {
      const path = displayPath(file.path);
      const diff = fileDiffs.get(file.path) ?? block.unifiedDiff;
      const oversized = Math.max(diff.split("\n").length, file.additions + file.deletions) > INLINE_DIFF_MAX_LINES;
      return <DiffHover key={file.path} path={file.path} diff={diff} additions={file.additions} deletions={file.deletions}>
        <button aria-label={intl.formatMessage({ id: "chat.changes.openFile", defaultMessage: "Open {path}" }, { path: file.path })}
          disabled={!canOpenFile} onClick={(event) => open(event, file.path)} type="button">
          <span className="thread-turn-diff__path"><span>{path.directory}</span><b>{path.basename}</b></span>
          <DiffStats additions={file.additions} deletions={file.deletions} />
          {oversized ? <span className="thread-turn-diff__large">{intl.formatMessage({ id: "chat.changes.inlineLarge", defaultMessage: "Too large to render inline" })}</span> : null}
        </button>
      </DiffHover>;
    })}{block.files.length > COLLAPSED_FILE_COUNT ? <button aria-expanded={expanded} className="thread-turn-diff__more"
      onClick={(event) => { reflow.begin(event.currentTarget); setExpanded(!expanded); }} type="button">
      {expanded ? intl.formatMessage({ id: "chat.changes.collapse", defaultMessage: "Collapse files" })
        : intl.formatMessage({ id: "chat.changes.showMore", defaultMessage: "{count, plural, one {Show # more file} other {Show # more files}}" }, { count: block.files.length - COLLAPSED_FILE_COUNT })}
      <ChevronDown aria-hidden="true" className={expanded ? "is-expanded" : undefined} size={12} />
    </button> : null}</div> : null}
  </section></Tooltip.Provider>;
}
