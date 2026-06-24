"use client";

import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square } from "lucide-react";
import styles from "../../styles/desktop.module.css";

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

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
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const rootRef = useRef<HTMLFormElement | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const [isDictating, setIsDictating] = useState(false);
  const supportsDictation =
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
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
  const handleDictationClick = () => {
    if (!supportsDictation) return;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) finalText += result[0]?.transcript ?? "";
      }
      const trimmedText = finalText.trim();
      if (!trimmedText) return;
      const prefix = valueRef.current.trim().length > 0 ? `${valueRef.current} ` : "";
      const nextValue = `${prefix}${trimmedText}`;
      valueRef.current = nextValue;
      onChangeRef.current(nextValue);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setIsDictating(false);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setIsDictating(false);
    };
    recognitionRef.current = recognition;
    setIsDictating(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsDictating(false);
    }
  };

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  }, [onChange, value]);

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
      recognitionRef.current?.stop();
    },
    [],
  );

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
              aria-label={isStopControl ? "Stop generation" : "Send message"}
              className={isStopControl ? styles.stopButton : styles.sendButton}
              disabled={isStopControl ? false : !canSubmit}
              onClick={isStopControl ? handleStop : undefined}
              title={isStopControl ? "Stop generation" : "Send message"}
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
    </form>
  );
}
