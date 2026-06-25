import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { SessionListItemWire } from "../../../vela-chat-client/src";
import type { ChatRenderModel } from "../../../vela-chat-render-model/src";
import { buildSessionListRowModel } from "../session-list/sessionListRowModel";
import { ConversationPreviewSurface } from "../thumbnail/ConversationPreviewSurface";

export interface SessionListSurfaceProps {
  sessions: SessionListItemWire[];
  currentSessionId: string | null;
  sessionPreviews?: Record<string, ChatRenderModel | undefined>;
  onArchiveSession?: (sessionId: string) => void | Promise<void>;
  onSelectSession: (sessionId: string) => void;
}

export function SessionListSurface({
  sessions,
  currentSessionId,
  sessionPreviews,
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
          previewModel={sessionPreviews?.[session.id]}
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
  previewModel,
  onArchiveSession,
  onSelect,
}: {
  session: SessionListItemWire;
  isActive: boolean;
  previewModel?: ChatRenderModel;
  onArchiveSession?: () => void | Promise<void>;
  onSelect: () => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLLIElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const row = buildSessionListRowModel(session, previewModel);

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
  const selectSessionFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  const menu = isMenuOpen ? (
    <div
      className="vela-popover-surface vela-session-actions-popover vela-motion-popover"
      role="menu"
      aria-label="Session actions"
      data-layer={canUseDocument() ? "portal" : "inline"}
      data-state="open"
      ref={menuRef}
      style={menuStyle ?? undefined}
    >
      <div className="vela-popover-menu">
        <button
          className="vela-popover-menu-item"
          type="button"
          role="menuitem"
          data-action="archive-session"
          onClick={(event) => {
            event.stopPropagation();
            void archiveSession();
          }}
        >
          <ArchiveGlyph />
          <span>{row.archiveMenuLabel}</span>
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
      data-activity={row.status.activity}
      data-has-actions={onArchiveSession ? "true" : undefined}
      data-running={row.status.isRunning ? "true" : undefined}
      data-waiting={row.status.isWaiting ? "true" : undefined}
      data-failed={row.status.isFailed ? "true" : undefined}
      data-has-thumbnail={row.status.hasThumbnail ? "true" : undefined}
    >
      <div
        className="vela-sidebar-menu-button vela-session-main"
        data-active={isActive ? "true" : undefined}
        data-sidebar="menu-button"
        data-size="compact"
        data-slot="session-list-surface-button"
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={selectSessionFromKeyboard}
      >
        <span className="vela-session-copy">
          <span className="vela-session-title-row">
            <span className="vela-session-title">{row.title}</span>
          </span>
          {row.compactPreview ? (
            <span
              className="vela-session-thumbnail-preview"
              data-slot="session-thumbnail-preview"
              aria-hidden="true"
              inert
            >
              <ConversationPreviewSurface
                model={row.compactPreview}
                scale={0.09}
              />
            </span>
          ) : (
            <>
              <span className="vela-session-preview">{row.previewLabel}</span>
              <span className="vela-session-meta">{row.metaLabel}</span>
            </>
          )}
        </span>
        {row.rail ? (
          <span className="vela-session-rail" data-recency={row.rail.recency} aria-hidden>
            {row.rail.label}
          </span>
        ) : null}
      </div>
      {onArchiveSession ? (
        <>
          <button
            ref={triggerRef}
            className="vela-session-actions-trigger"
            type="button"
            aria-label={row.archiveActionLabel}
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
