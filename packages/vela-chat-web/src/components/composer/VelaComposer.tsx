"use client";

import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import { ComposerControls } from "../composer-controls/ComposerControls";
import type { ComposerControlsModel } from "../composer-controls/model";
import { useAutoResizeTextarea } from "../../hooks/useAutoResizeTextarea";
import { useComposerKeyboard } from "../../hooks/useComposerKeyboard";
import { PromptInput } from "../../primitives/prompt-input/PromptInput";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";

export function VelaComposer({
  draft,
  placeholder,
  canSend,
  controls,
  isUpdatingControls,
  pendingAttachments = [],
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onRemoveAttachment,
  onSubmit,
}: {
  draft: string;
  placeholder: string;
  canSend: boolean;
  controls?: ComposerControlsModel;
  isUpdatingControls?: boolean;
  pendingAttachments?: PromptInputAttachment[];
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onSubmit: () => void;
}) {
  const textareaRef = useAutoResizeTextarea(draft);
  const canSubmit = canSend && (draft.trim().length > 0 || pendingAttachments.length > 0);
  const handleKeyDown = useComposerKeyboard(() => {
    if (canSubmit) onSubmit();
  });

  return (
    <PromptInput
      canSubmit={canSubmit}
      onChange={onDraftChange}
      onAttachImages={onAttachImages}
      onKeyDown={handleKeyDown}
      onRemoveAttachment={onRemoveAttachment}
      onSubmit={onSubmit}
      pendingAttachments={pendingAttachments}
      placeholder={placeholder}
      textareaRef={textareaRef}
      leftToolbarControls={
        controls && onAgentConfigChange ? (
          <ComposerControls
            controls={controls}
            isUpdating={isUpdatingControls}
            placement="primary"
            onChange={onAgentConfigChange}
          />
        ) : null
      }
      rightToolbarControls={
        controls && onAgentConfigChange ? (
          <ComposerControls
            controls={controls}
            isUpdating={isUpdatingControls}
            placement="secondary"
            onChange={onAgentConfigChange}
          />
        ) : null
      }
      value={draft}
    />
  );
}
