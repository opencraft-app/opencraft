"use client";

import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Mic, Square, WandSparkles } from "lucide-react";
import type { VoiceInputHost, VoiceInputState } from "../../../../vela-desktop-shell/src";
import { LexicalComposerEditor, type ComposerEditorHandle } from "../../composer-editor";
import type { ComposerSkill, ComposerSkillTrigger } from "../../composer-skills/model";
import {
  applyComposerSkillToken,
  readComposerSkillTrigger,
} from "../../composer-skills/model";
import {
  clampComposerSuggestionIndex,
  createSkillSuggestionItems,
  nextComposerSuggestionIndex,
  type ComposerSuggestionItem,
} from "../../composer-suggestions/model";
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
  canSubmitText?: boolean;
  isRunning: boolean;
  layout?: "dock" | "inline";
  submitLabel?: string;
  stopLabel?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitText?: (value: string) => void | Promise<void>;
  onStop?: () => void;
  onAttachImages?: (files: File[]) => void;
  onHeightChange?: (height: number) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  pendingAttachments?: PromptInputAttachment[];
  skills?: ComposerSkill[];
  voiceInput?: VoiceInputHost;
  leftToolbarControls?: ReactNode;
  rightToolbarControls?: ReactNode;
  attachedSurface?: ReactNode;
}

export function PromptInput({
  value,
  placeholder,
  canSubmit,
  canSubmitText,
  isRunning,
  layout = "dock",
  submitLabel = "Send message",
  stopLabel = "Stop generation",
  onChange,
  onSubmit,
  onSubmitText,
  onStop,
  onAttachImages,
  onHeightChange,
  onRemoveAttachment,
  pendingAttachments = [],
  skills = [],
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
  const [skillTrigger, setSkillTrigger] = useState<ComposerSkillTrigger | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const isStopControl = isRunning && !canSubmit && Boolean(onStop);
  const primaryControlLabel = isStopControl ? stopLabel : submitLabel;
  const suggestionItems = useMemo(
    () => createSkillSuggestionItems(skills, skillTrigger),
    [skillTrigger, skills],
  );
  const skillTokenNames = useMemo(() => skills.map((skill) => skill.name), [skills]);
  const activeSuggestion = suggestionItems[activeSuggestionIndex] ?? suggestionItems[0] ?? null;
  const isSuggestionMenuOpen = suggestionItems.length > 0;
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };
  const handleEditorSubmit = () => {
    if (canSubmit) onSubmit();
  };
  const handleEditorSubmitText = (text: string) => {
    if (canSubmitText ?? canSubmit) void onSubmitText?.(text);
  };
  const handleChange = (nextValue: string) => {
    valueRef.current = nextValue;
    onChange(nextValue);
  };
  const handleSkillSelect = useCallback((skill: ComposerSkill) => {
    if (!skillTrigger) return;
    const next = applyComposerSkillToken(valueRef.current, skillTrigger, skill, "$");
    setSkillTrigger(null);
    setActiveSuggestionIndex(0);
    valueRef.current = next.value;
    onChange(next.value);
    requestAnimationFrame(() => {
      editorRef.current?.focusAt(next.cursorIndex);
    });
  }, [onChange, skillTrigger]);
  const handleSuggestionSelect = useCallback(
    (item: ComposerSuggestionItem | null) => {
      if (!item) return;
      if (item.type === "skill") handleSkillSelect(item.skill);
    },
    [handleSkillSelect],
  );
  const handleComposerCommandKey = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "Tab") => {
      if (!isSuggestionMenuOpen) return false;
      if (key === "ArrowDown") {
        setActiveSuggestionIndex((index) =>
          nextComposerSuggestionIndex(suggestionItems.length, index, 1),
        );
        return true;
      }
      if (key === "ArrowUp") {
        setActiveSuggestionIndex((index) =>
          nextComposerSuggestionIndex(suggestionItems.length, index, -1),
        );
        return true;
      }
      if (key === "Escape") {
        setSkillTrigger(null);
        setActiveSuggestionIndex(0);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        handleSuggestionSelect(activeSuggestion);
        return true;
      }
      return false;
    },
    [activeSuggestion, handleSuggestionSelect, isSuggestionMenuOpen, suggestionItems.length],
  );
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
    setActiveSuggestionIndex((index) =>
      clampComposerSuggestionIndex(suggestionItems.length, index),
    );
  }, [suggestionItems.length]);

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
      {isSuggestionMenuOpen ? (
        <div className={styles.skillMenu} role="listbox" aria-label="Skills">
          {suggestionItems.map((item, index) => (
            <button
              aria-selected={index === activeSuggestionIndex}
              className={[
                styles.skillMenuItem,
                index === activeSuggestionIndex ? styles.skillMenuItemActive : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={item.id}
              onMouseDown={(event) => {
                event.preventDefault();
                handleSuggestionSelect(item);
              }}
              onMouseEnter={() => setActiveSuggestionIndex(index)}
              role="option"
              type="button"
            >
              <span className={styles.skillMenuIcon} aria-hidden="true">
                <WandSparkles size={14} strokeWidth={2} />
              </span>
              <span className={styles.skillMenuText}>
                <span className={styles.skillMenuName}>${item.skill.name}</span>
                <span className={styles.skillMenuDescription}>{item.detail}</span>
              </span>
              <span className={styles.skillMenuMeta}>{item.meta}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.composer}>
        <LexicalComposerEditor
          ariaLabel="Message"
          canSubmitText={canSubmitText ?? canSubmit}
          className={styles.composerEditor}
          placeholderClassName={styles.composerEditorPlaceholder}
          value={value}
          onChange={handleChange}
          onSnapshotChange={(snapshot) => {
            setSkillTrigger(readComposerSkillTrigger(snapshot.value, snapshot.expandedCursor));
          }}
          onCommandKeyDown={(key) => handleComposerCommandKey(key)}
          onSubmit={handleEditorSubmit}
          onSubmitText={handleEditorSubmitText}
          placeholder={placeholder}
          skillTokenNames={skillTokenNames}
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
