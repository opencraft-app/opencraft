"use client";

import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useRef } from "react";
import styles from "../../styles/desktop.module.css";

export interface PromptInputAttachment {
  id: string;
  label: string;
  mimeType?: string;
}

export interface PromptInputProps {
  value: string;
  placeholder: string;
  canSubmit: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  onAttachImages?: (files: File[]) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  pendingAttachments?: PromptInputAttachment[];
  leftToolbarControls?: ReactNode;
  rightToolbarControls?: ReactNode;
}

export function PromptInput({
  value,
  placeholder,
  canSubmit,
  textareaRef,
  onChange,
  onKeyDown,
  onSubmit,
  onAttachImages,
  onRemoveAttachment,
  pendingAttachments = [],
  leftToolbarControls,
  rightToolbarControls,
}: PromptInputProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };
  const handleAttachClick = () => {
    imageInputRef.current?.click();
  };
  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) onAttachImages?.(files);
  };

  return (
    <form className={styles.composerDock} onSubmit={handleSubmit}>
      <div className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          ref={textareaRef}
        />
        {pendingAttachments.length > 0 ? (
          <div className={styles.attachmentTray} aria-label="Pending attachments">
            {pendingAttachments.map((attachment) => (
              <span className={styles.attachmentPill} key={attachment.id}>
                <span className={styles.attachmentIcon} aria-hidden="true">
                  ▧
                </span>
                <span className={styles.attachmentLabel}>{attachment.label}</span>
                {onRemoveAttachment ? (
                  <button
                    aria-label={`Remove ${attachment.label}`}
                    className={styles.attachmentRemove}
                    onClick={() => onRemoveAttachment(attachment.id)}
                    type="button"
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        <div className={styles.composerFooter}>
          <div className={styles.composerLeft}>
            <input
              accept="image/*"
              className={styles.hiddenFileInput}
              multiple
              onChange={handleImageChange}
              ref={imageInputRef}
              type="file"
            />
            <button
              className={styles.iconButton}
              disabled={!onAttachImages}
              onClick={handleAttachClick}
              type="button"
              aria-label="Attach image"
            >
              +
            </button>
            {leftToolbarControls}
          </div>
          <div className={styles.composerRight}>
            {rightToolbarControls}
            <button
              aria-label="Dictation unavailable"
              className={styles.iconButton}
              disabled
              title="Dictation unavailable"
              type="button"
            >
              ⌘
            </button>
            <button
              aria-label="Send message"
              className={styles.sendButton}
              disabled={!canSubmit}
              title="Send message"
              type="submit"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
