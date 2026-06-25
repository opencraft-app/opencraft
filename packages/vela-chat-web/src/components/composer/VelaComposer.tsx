"use client";

import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import type { QueuedComposerInputClientState } from "../../../../vela-chat-host-state/src";
import type { VoiceInputHost } from "../../../../vela-desktop-shell/src";
import { CornerDownRight, Trash2 } from "lucide-react";
import { ComposerControls } from "../composer-controls/ComposerControls";
import type { ComposerControlsModel } from "../composer-controls/model";
import { PromptInput } from "../../primitives/prompt-input/PromptInput";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";
import styles from "../../styles/desktop.module.css";

export function VelaComposer({
  draft,
  placeholder,
  canSend,
  controls,
  isRunning,
  isUpdatingControls,
  pendingAttachments = [],
  queuedInputs = [],
  voiceInput,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onHeightChange,
  onRemoveAttachment,
  onRemoveQueuedInput,
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
  queuedInputs?: QueuedComposerInputClientState[];
  voiceInput?: VoiceInputHost;
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onHeightChange?: (height: number) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onRemoveQueuedInput?: (queuedInputId: string) => void;
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
      voiceInput={voiceInput}
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
      attachedSurface={
        queuedInputs.length > 0 ? (
          <div className={styles.localQueueTrack} aria-label="Queued messages">
            {queuedInputs.map((item, index) => (
              <div className={styles.localQueueRow} key={item.id}>
                <span className={styles.localQueueIndex} aria-hidden="true">
                  <CornerDownRight size={14} strokeWidth={2} />
                  <span>{index + 1}</span>
                </span>
                <span className={styles.localQueueText}>{item.previewText}</span>
                {onRemoveQueuedInput ? (
                  <button
                    aria-label={`Remove queued message ${index + 1}`}
                    className={styles.localQueueRemove}
                    onClick={() => onRemoveQueuedInput(item.id)}
                    type="button"
                  >
                    <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null
      }
      value={draft}
    />
  );
}
