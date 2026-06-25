"use client";

import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import { ComposerControls } from "../composer-controls/ComposerControls";
import type { ComposerControlsModel } from "../composer-controls/model";
import { PromptInput } from "../../primitives/prompt-input/PromptInput";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";

export function VelaComposer({
  draft,
  placeholder,
  canSend,
  controls,
  isRunning,
  isUpdatingControls,
  pendingAttachments = [],
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onHeightChange,
  onRemoveAttachment,
  onStop,
  onSubmit,
}: {
  draft: string;
  placeholder: string;
  canSend: boolean;
  controls?: ComposerControlsModel;
  isRunning: boolean;
  isUpdatingControls?: boolean;
  pendingAttachments?: PromptInputAttachment[];
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onHeightChange?: (height: number) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onStop?: () => void;
  onSubmit: () => void;
}) {
  const canSubmit = canSend && (draft.trim().length > 0 || pendingAttachments.length > 0);

  return (
    <PromptInput
      canSubmit={canSubmit}
      isRunning={isRunning}
      onChange={onDraftChange}
      onAttachImages={onAttachImages}
      onHeightChange={onHeightChange}
      onRemoveAttachment={onRemoveAttachment}
      onStop={onStop}
      onSubmit={onSubmit}
      pendingAttachments={pendingAttachments}
      placeholder={placeholder}
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
