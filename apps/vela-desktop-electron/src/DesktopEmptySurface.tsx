import type { FormEvent, KeyboardEvent } from "react";
import React from "react";
import {
  Brain,
  CornerDownLeft,
  Folder,
  Mic,
  Plus,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from "lucide-react";

export interface DesktopHomeSurfaceProps {
  canCreateSession?: boolean;
  draft?: string;
  error?: string | null;
  isCreatingSession?: boolean;
  locationLabel?: string;
  modelLabel?: string;
  permissionLabel?: string;
  reasoningLabel?: string;
  sourceLabel?: string;
  onDraftChange?: (value: string) => void;
  onSubmit?: () => void;
}

export function DesktopEmptySurface({
  canCreateSession = true,
  draft = "",
  error,
  isCreatingSession = false,
  locationLabel = "本地",
  modelLabel = "Agent",
  permissionLabel = "Default permissions",
  reasoningLabel = "High",
  sourceLabel = "Vela/local",
  onDraftChange,
  onSubmit,
}: DesktopHomeSurfaceProps) {
  const canSubmit = canCreateSession && !isCreatingSession;
  const submitHomePrompt = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSubmit) onSubmit?.();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitHomePrompt();
  };

  if (error) {
    return (
      <div className="vela-desktop-empty" role="status">
        <section className="vela-home-panel" aria-label="Desktop home">
          <HomeHeader sourceLabel={sourceLabel} locationLabel={locationLabel} />
          <p className="vela-home-error">{error}</p>
          <HomeComposer
            canSubmit={canSubmit}
            draft={draft}
            isCreatingSession={isCreatingSession}
            modelLabel={modelLabel}
            permissionLabel={permissionLabel}
            reasoningLabel={reasoningLabel}
            onDraftChange={onDraftChange}
            onKeyDown={handleKeyDown}
            onSubmit={submitHomePrompt}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="vela-desktop-empty">
      <section className="vela-home-panel" aria-label="Desktop home">
        <HomeHeader sourceLabel={sourceLabel} locationLabel={locationLabel} />
        <HomeComposer
          canSubmit={canSubmit}
          draft={draft}
          isCreatingSession={isCreatingSession}
          modelLabel={modelLabel}
          permissionLabel={permissionLabel}
          reasoningLabel={reasoningLabel}
          onDraftChange={onDraftChange}
          onKeyDown={handleKeyDown}
          onSubmit={submitHomePrompt}
        />
      </section>
    </div>
  );
}

function HomeHeader({
  sourceLabel,
  locationLabel,
}: {
  sourceLabel: string;
  locationLabel: string;
}) {
  return (
    <header className="vela-home-header">
      <h1>新建 workspace</h1>
      <div className="vela-home-context" aria-label="Workspace context">
        <span className="vela-home-source-badge" aria-hidden="true">
          {sourceLabel.trim().charAt(0).toUpperCase() || "V"}
        </span>
        <button className="vela-home-context-button" type="button">
          {sourceLabel}
          <span aria-hidden="true">⌄</span>
        </button>
        <button className="vela-home-context-button" type="button">
          <Folder size={17} strokeWidth={1.9} aria-hidden="true" />
          {locationLabel}
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
    </header>
  );
}

function HomeComposer({
  canSubmit,
  draft,
  isCreatingSession,
  modelLabel,
  permissionLabel,
  reasoningLabel,
  onDraftChange,
  onKeyDown,
  onSubmit,
}: {
  canSubmit: boolean;
  draft: string;
  isCreatingSession: boolean;
  modelLabel: string;
  permissionLabel: string;
  reasoningLabel: string;
  onDraftChange?: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="vela-home-composer" onSubmit={onSubmit}>
      <label className="vela-home-composer-label" htmlFor="vela-home-prompt">
        给 Agent 发消息，标记 @files，或使用 /commands 和 /skills
      </label>
      <textarea
        className="vela-home-composer-input"
        id="vela-home-prompt"
        onChange={(event) => onDraftChange?.(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="给 Agent 发消息，标记 @files，或使用 /commands 和 /skills"
        rows={3}
        value={draft}
      />
      <div className="vela-home-composer-footer">
        <div className="vela-home-composer-left">
          <button className="vela-home-icon-button" type="button" aria-label="Attach context">
            <Plus size={20} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button className="vela-home-control" type="button">
            <Sparkles size={17} strokeWidth={1.8} aria-hidden="true" />
            {modelLabel}
            <span aria-hidden="true">⌄</span>
          </button>
          <button className="vela-home-control" type="button">
            <Brain size={17} strokeWidth={1.85} aria-hidden="true" />
            {reasoningLabel}
            <span aria-hidden="true">⌄</span>
          </button>
          <button className="vela-home-control" type="button">
            <Shield size={17} strokeWidth={1.9} aria-hidden="true" />
            {permissionLabel}
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
        <div className="vela-home-composer-right">
          <button className="vela-home-icon-button" type="button" aria-label="Quick actions">
            <Zap size={19} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button className="vela-home-icon-button" type="button" aria-label="Composer settings">
            <SlidersHorizontal size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button className="vela-home-icon-button" type="button" aria-label="Dictation">
            <Mic size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button
            className="vela-home-submit"
            disabled={!canSubmit}
            type="submit"
            aria-label="Start workspace"
          >
            {isCreatingSession ? (
              <span className="vela-home-submit-dot" aria-hidden="true" />
            ) : (
              <CornerDownLeft size={21} strokeWidth={2.2} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
