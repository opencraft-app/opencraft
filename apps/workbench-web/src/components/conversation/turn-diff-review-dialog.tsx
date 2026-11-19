import type { TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "../ui/button";

import { ModalSurface } from "../modal";
import { UnifiedDiffPreview } from "../conversation-renderers/unified-diff-preview";
import { reviewDiffForFile } from "./turn-diff-review";

interface TurnDiffReviewDialogProps {
  readonly block: TurnDiffTimelineBlock;
  readonly initialPath: string | null;
  readonly onClose: () => void;
  readonly onLoadItemDetails?: (ids: readonly string[], signal: AbortSignal) => Promise<void>;
}

export function TurnDiffReviewDialog({ block, initialPath, onClose, onLoadItemDetails }: TurnDiffReviewDialogProps) {
  const intl = useIntl();
  const [attempt, setAttempt] = useState(0);
  const [targets, setTargets] = useState(() => block.detailItemIds ?? []);
  const [detailState, setDetailState] = useState<"loading" | "unavailable">("loading");
  const ids = JSON.stringify(targets);
  const incomplete = block.contentAvailable === false;
  useEffect(() => {
    if (!incomplete) return;
    if (ids === "[]" || !onLoadItemDetails) { setDetailState("unavailable"); return; }
    const controller = new AbortController();
    setDetailState("loading");
    // The existing conversation lease owns reading and revision fencing. Closing
    // Review or switching its Thread revokes this request, never another View.
    // Keep this request's targets stable as each returned Item hydrates; a
    // shrinking pending-ID list must not cancel the remaining sequential reads.
    void onLoadItemDetails(JSON.parse(ids), controller.signal).then(() => {
      if (!controller.signal.aborted) setDetailState("unavailable");
    }, () => { if (!controller.signal.aborted) setDetailState("unavailable"); });
    return () => controller.abort();
  }, [incomplete, ids, onLoadItemDetails, attempt]);
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const diff = useMemo(() => reviewDiffForFile(block.unifiedDiff, selectedPath), [block.unifiedDiff, selectedPath]);
  return (
    <ModalSurface className="thread-turn-diff-review" label="Review changed files" onDismiss={onClose} size="wide">
      <header className="thread-turn-diff-review__header">
        <strong>{block.files.length === 1 ? "1 file changed" : `${block.files.length} files changed`}</strong>
        <span>Read-only review</span>
      </header>
      {block.files.length > 1 ? (
        <nav aria-label="Changed files" className="thread-turn-diff-review__files">
          <button aria-current={selectedPath === null ? "page" : undefined} onClick={() => setSelectedPath(null)} type="button">All files</button>
          {block.files.map((file) => (
            <button aria-current={selectedPath === file.path ? "page" : undefined} key={file.path} onClick={() => setSelectedPath(file.path)} title={file.path} type="button">
              {file.path}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="thread-turn-diff-review__diff" aria-busy={incomplete && detailState === "loading" || undefined}>
        {!incomplete ? <UnifiedDiffPreview diff={diff} /> : <div role="status">
          <p>{detailState === "loading"
            ? intl.formatMessage({ id: "chat.changes.loadingDetails", defaultMessage: "Loading change details…" })
            : intl.formatMessage({ id: "chat.changes.detailsUnavailable", defaultMessage: "Could not load change details." })}</p>
          {detailState === "unavailable" && onLoadItemDetails && (block.detailItemIds?.length ?? 0) > 0 ? <Button variant="outline" size="toolbar" onClick={() => { setTargets(block.detailItemIds ?? []); setAttempt(value => value + 1); }}>
            {intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}
          </Button> : null}
        </div>}
      </div>
    </ModalSurface>
  );
}
