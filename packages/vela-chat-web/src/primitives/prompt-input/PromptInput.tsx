"use client";

import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Mic, Square } from "lucide-react";
import type { VoiceInputHost, VoiceInputState } from "../../../../vela-desktop-shell/src";
import { LexicalComposerEditor, type ComposerEditorHandle } from "../../composer-editor";
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
  layout?: "dock" | "inline";
  submitLabel?: string;
  stopLabel?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachImages?: (files: File[]) => void;
  onHeightChange?: (height: number) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  pendingAttachments?: PromptInputAttachment[];
  voiceInput?: VoiceInputHost;
  leftToolbarControls?: ReactNode;
  rightToolbarControls?: ReactNode;
  attachedSurface?: ReactNode;
}

export function PromptInput({
  value,
  placeholder,
  canSubmit,
  isRunning,
  layout = "dock",
  submitLabel = "Send message",
  stopLabel = "Stop generation",
  onChange,
  onSubmit,
  onStop,
  onAttachImages,
  onHeightChange,
  onRemoveAttachment,
  pendingAttachments = [],
  voiceInput,
  leftToolbarControls,
  rightToolbarControls,
  attachedSurface,
}: PromptInputProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<ComposerEditorHandle | null>(null);
  const rootRef = useRef<HTMLFormElement | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const voiceInputRef = useRef<VoiceInputHost | undefined>(voiceInput);
  const [isDictating, setIsDictating] = useState(false);
  const [supportsDictation, setSupportsDictation] = useState(Boolean(voiceInput));
  const isStopControl = isRunning && !canSubmit && Boolean(onStop);
  const primaryControlLabel = isStopControl ? stopLabel : submitLabel;
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };
  const handleEditorSubmit = () => {
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
  const handleDictationClick = () => {
    const host = voiceInputRef.current;
    if (!host || !supportsDictation) return;
    if (isDictating) {
      void host.stop();
      return;
    }
    void host.start({ interimResults: true });
  };

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  }, [onChange, value]);

  useEffect(() => {
    voiceInputRef.current = voiceInput;
    if (!voiceInput) {
      setSupportsDictation(false);
      setIsDictating(false);
      return;
    }

    let disposed = false;
    void Promise.resolve(voiceInput.isAvailable()).then((available) => {
      if (!disposed) setSupportsDictation(available);
    });

    const appendFinalTranscript = (text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;
      const prefix = valueRef.current.trim().length > 0 ? `${valueRef.current} ` : "";
      const nextValue = `${prefix}${trimmedText}`;
      valueRef.current = nextValue;
      onChangeRef.current(nextValue);
    };
    const updateState = (state: VoiceInputState) => {
      setIsDictating(state === "listening" || state === "requesting-permission");
    };
    const unsubscribeFinal = voiceInput.onFinalTranscript(appendFinalTranscript);
    const unsubscribeState = voiceInput.onStateChange(updateState);
    const unsubscribeError = voiceInput.onError((error) => {
      console.warn("[PromptInput] voice input failed", error);
      setIsDictating(false);
    });

    return () => {
      disposed = true;
      unsubscribeFinal();
      unsubscribeState();
      unsubscribeError();
    };
  }, [voiceInput]);

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

  useEffect(
    () => () => {
      void voiceInputRef.current?.stop();
    },
    [],
  );

  return (
    <form
      className={[
        styles.composerRoot,
        styles.composerDock,
        layout === "inline" ? styles.composerDockInline : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onSubmit={handleSubmit}
      ref={rootRef}
    >
      <div className={styles.composer}>
        <LexicalComposerEditor
          ariaLabel="Message"
          className={styles.composerEditor}
          placeholderClassName={styles.composerEditorPlaceholder}
          value={value}
          onChange={onChange}
          onSubmit={handleEditorSubmit}
          placeholder={placeholder}
          ref={editorRef}
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
              <ImagePlus size={17} strokeWidth={2.1} aria-hidden="true" />
            </button>
            {leftToolbarControls}
          </div>
          <div className={styles.composerRight}>
            {rightToolbarControls}
            <button
              aria-label={isDictating ? "Stop dictation" : "Start dictation"}
              className={[styles.iconButton, isDictating ? styles.dictationActive : ""]
                .filter(Boolean)
                .join(" ")}
              disabled={!supportsDictation}
              onClick={handleDictationClick}
              title={supportsDictation ? "Dictation" : "Dictation unavailable"}
              type="button"
            >
              <Mic size={17} strokeWidth={2.1} aria-hidden="true" />
            </button>
            <button
              aria-label={primaryControlLabel}
              className={isStopControl ? styles.stopButton : styles.sendButton}
              disabled={isStopControl ? false : !canSubmit}
              onClick={isStopControl ? handleStop : undefined}
              title={primaryControlLabel}
              type={isStopControl ? "button" : "submit"}
            >
              {isStopControl ? (
                <Square size={13} strokeWidth={0} fill="currentColor" aria-hidden="true" />
              ) : (
                <ArrowUp size={22} strokeWidth={2.4} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
      {attachedSurface ? (
        <div className={styles.composerAttachedSurface}>{attachedSurface}</div>
      ) : null}
    </form>
  );
}
