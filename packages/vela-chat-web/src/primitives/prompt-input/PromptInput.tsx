"use client";

import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
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
  isRunning: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachImages?: (files: File[]) => void;
  onHeightChange?: (height: number) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  pendingAttachments?: PromptInputAttachment[];
  leftToolbarControls?: ReactNode;
  rightToolbarControls?: ReactNode;
}

export function PromptInput({
  value,
  placeholder,
  canSubmit,
  isRunning,
  textareaRef,
  onChange,
  onKeyDown,
  onSubmit,
  onStop,
  onAttachImages,
  onHeightChange,
  onRemoveAttachment,
  pendingAttachments = [],
  leftToolbarControls,
  rightToolbarControls,
}: PromptInputProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLFormElement | null>(null);
  const isStopControl = isRunning && !canSubmit && Boolean(onStop);
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };
  const handleStop = () => {
    if (isStopControl) onStop?.();
  };
  const handleAttachClick = () => {
    imageInputRef.current?.click();
  };
  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) onAttachImages?.(files);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onHeightChange || typeof ResizeObserver === "undefined") return;

    const publishHeight = () => {
      onHeightChange(root.getBoundingClientRect().height);
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, [onHeightChange]);

  return (
    <form className={styles.composerDock} onSubmit={handleSubmit} ref={rootRef}>
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
              aria-label={isStopControl ? "Stop generation" : "Send message"}
              className={isStopControl ? styles.stopButton : styles.sendButton}
              disabled={isStopControl ? false : !canSubmit}
              onClick={isStopControl ? handleStop : undefined}
              title={isStopControl ? "Stop generation" : "Send message"}
              type={isStopControl ? "button" : "submit"}
            >
              {isStopControl ? <span className={styles.stopGlyph} aria-hidden="true" /> : "↑"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
