import type { TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { useMemo, useState } from "react";

import { ModalSurface } from "../modal";
import { UnifiedDiffPreview } from "../conversation-renderers/unified-diff-preview";
import { reviewDiffForFile } from "./turn-diff-review";

interface TurnDiffReviewDialogProps {
  readonly block: TurnDiffTimelineBlock;
  readonly initialPath: string | null;
  readonly onClose: () => void;
}

export function TurnDiffReviewDialog({ block, initialPath, onClose }: TurnDiffReviewDialogProps) {
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
      <div className="thread-turn-diff-review__diff"><UnifiedDiffPreview diff={diff} /></div>
    </ModalSurface>
  );
}
