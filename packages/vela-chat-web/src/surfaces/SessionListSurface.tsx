import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionListItemWire } from "../../../vela-chat-client/src";

export interface SessionListSurfaceProps {
  sessions: SessionListItemWire[];
  currentSessionId: string | null;
  onArchiveSession?: (sessionId: string) => void | Promise<void>;
  onSelectSession: (sessionId: string) => void;
}

export function SessionListSurface({
  sessions,
  currentSessionId,
  onArchiveSession,
  onSelectSession,
}: SessionListSurfaceProps) {
  return (
    <ul className="vela-sidebar-menu session-list" data-sidebar="menu" data-slot="session-list-surface">
      {sessions.map((session) => (
        <SessionListSurfaceItem
          key={session.id}
          session={session}
          isActive={session.id === currentSessionId}
          onArchiveSession={onArchiveSession ? () => onArchiveSession(session.id) : undefined}
          onSelect={() => onSelectSession(session.id)}
        />
      ))}
    </ul>
  );
}

function SessionListSurfaceItem({
  session,
  isActive,
  onArchiveSession,
  onSelect,
}: {
  session: SessionListItemWire;
  isActive: boolean;
  onArchiveSession?: () => void | Promise<void>;
  onSelect: () => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLLIElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isRunning = session.running || session.status === "running";
  const isWaiting = session.status === "waiting_for_input" || session.pending_request_count > 0;
  const isFailed = session.status === "failed";
  const badgeLabel = isWaiting
    ? session.pending_request_count > 0
      ? `${session.pending_request_count} request`
      : "Waiting"
    : isRunning
      ? "Running"
      : null;

  useEffect(() => {
    if (!isMenuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const menu = menuRef.current;
      const target = event.target;
      if (root && target instanceof Node && root.contains(target)) return;
      if (menu && target instanceof Node && menu.contains(target)) return;
      setIsMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMenuOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isMenuOpen]);

  useLayoutEffect(() => {
    if (!isMenuOpen || !canUseDocument()) {
      setMenuStyle(null);
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setMenuStyle({
        position: "fixed",
        top: `${rect.bottom + 6}px`,
        left: `${Math.max(8, Math.min(rect.right - 164, window.innerWidth - 172))}px`,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isMenuOpen]);

  const archiveSession = async () => {
    setIsMenuOpen(false);
    await onArchiveSession?.();
  };

  const menu = isMenuOpen ? (
    <div
      className="vela-settings-popover vela-motion-popover vela-session-actions-popover"
      role="menu"
      aria-label="Session actions"
      data-layer={canUseDocument() ? "portal" : "inline"}
      data-state="open"
      ref={menuRef}
      style={menuStyle ?? undefined}
    >
      <div className="vela-settings-menu">
        <button
          className="vela-settings-menu-item"
          type="button"
          role="menuitem"
          data-action="archive-session"
          onClick={(event) => {
            event.stopPropagation();
            void archiveSession();
          }}
        >
          <ArchiveGlyph />
          <span>Archive chat</span>
        </button>
      </div>
    </div>
  ) : null;

  return (
    <li
      ref={rootRef}
      className={["vela-sidebar-menu-item vela-session-item", isActive ? "active" : ""]
        .filter(Boolean)
        .join(" ")}
      data-sidebar="menu-item"
      data-slot="session-list-surface-item"
      data-status={session.status}
      data-has-actions={onArchiveSession ? "true" : undefined}
      data-running={isRunning ? "true" : undefined}
      data-waiting={isWaiting ? "true" : undefined}
      data-failed={isFailed ? "true" : undefined}
    >
      <button
        className="vela-sidebar-menu-button vela-session-main"
        data-active={isActive ? "true" : undefined}
        data-sidebar="menu-button"
        data-size="compact"
        data-slot="session-list-surface-button"
        type="button"
        onClick={onSelect}
      >
        <span className="vela-session-icon" aria-hidden>
          <MessageGlyph />
          <span className="vela-session-status-dot" />
        </span>
        <span className="vela-session-copy">
          <span className="vela-session-title-row">
            <span className="vela-session-title">{session.title || session.id}</span>
            {badgeLabel ? <span className="vela-session-badge">{badgeLabel}</span> : null}
          </span>
          <span className="vela-session-preview">{sessionPreviewLabel(session)}</span>
          <span className="vela-session-meta">{sessionMetaLabel(session)}</span>
        </span>
        <span className="vela-session-rail" aria-hidden>
          {sessionRailLabel(session)}
        </span>
      </button>
      {onArchiveSession ? (
        <>
          <button
            ref={triggerRef}
            className="vela-session-actions-trigger"
            type="button"
            aria-label={`Session actions for ${session.title || session.id}`}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen ? "true" : "false"}
            onClick={(event) => {
              event.stopPropagation();
              setIsMenuOpen((current) => !current);
            }}
          >
            <MoreGlyph />
          </button>
          {menu ? renderMenu(menu) : null}
        </>
      ) : null}
    </li>
  );
}

function renderMenu(menu: JSX.Element) {
  if (!canUseDocument()) return menu;
  return createPortal(menu, document.body);
}

function canUseDocument() {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function MoreGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6.5 12h.01M12 12h.01M17.5 12h.01"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArchiveGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7.5h14M8 7.5V5.75C8 4.78 8.78 4 9.75 4h4.5C15.22 4 16 4.78 16 5.75V7.5M7 10v7.25C7 18.77 8.23 20 9.75 20h4.5C15.77 20 17 18.77 17 17.25V10M10 13h4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MessageGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 6.5C5 5.12 6.12 4 7.5 4h9C17.88 4 19 5.12 19 6.5v6c0 1.38-1.12 2.5-2.5 2.5H10l-4.2 3.2c-.33.25-.8.02-.8-.4V6.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.5 8.5h7M8.5 11.5h4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function sessionMetaLabel(session: SessionListItemWire) {
  const backend = session.backend;
  const model = session.agent_config?.model ?? session.model;
  return [backend, model].filter(Boolean).join(" · ");
}

function sessionPreviewLabel(session: SessionListItemWire) {
  const preview = session.preview.trim();
  if (preview) return preview;

  const cwd = session.working_directory.trim();
  if (cwd) return cwd.split("/").filter(Boolean).at(-1) ?? cwd;

  return sessionMetaLabel(session);
}

function sessionRailLabel(session: SessionListItemWire) {
  return relativeSessionTime(session.last_activity_at || session.updated_at);
}

function relativeSessionTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return "now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
