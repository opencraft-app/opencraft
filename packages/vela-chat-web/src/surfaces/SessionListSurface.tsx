import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Folder } from "lucide-react";
import type { SessionListItemWire } from "../../../vela-chat-client/src";
import type { ChatRenderModel } from "../../../vela-chat-render-model/src";
import { useDismissableLayer } from "../../../vela-ui/src";
import { useVerticalScrollbarOverlay } from "../conversation-runtime/scrollbar/useVerticalScrollbarOverlay";
import { buildSessionListRowModel } from "../session-list/sessionListRowModel";
import styles from "../styles/desktop.module.css";
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLUListElement | null>(null);
  const scrollbarOverlay = useVerticalScrollbarOverlay(scrollRef, {
    contentRef,
  });

  return (
    <div
      className={styles.sessionListScrollShell}
      data-slot="session-list-scroll-shell"
    >
      <div
        className={styles.sessionListScrollViewport}
        data-slot="session-list-scroll-viewport"
        ref={scrollRef}
      >
        <ul
          className="vela-sidebar-menu session-list"
          data-sidebar="menu"
          data-slot="session-list-surface"
          ref={contentRef}
        >
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
      </div>
      {scrollbarOverlay}
    </div>
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
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLLIElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const row = buildSessionListRowModel(session, previewModel);
  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  useDismissableLayer({
    enabled: isMenuOpen,
    refs: [menuRef],
    onDismiss: closeMenu,
  });

  useLayoutEffect(() => {
    if (!isMenuOpen || !menuAnchor || !canUseDocument()) {
      setMenuStyle(null);
      return;
    }

    const updatePosition = () => {
      setMenuStyle({
        position: "fixed",
        top: `${Math.max(8, Math.min(menuAnchor.y + 6, window.innerHeight - 64))}px`,
        left: `${Math.max(8, Math.min(menuAnchor.x, window.innerWidth - 172))}px`,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isMenuOpen, menuAnchor]);

  const archiveSession = async () => {
    closeMenu();
    await onArchiveSession?.();
  };
  const selectSessionFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
      return;
    }
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    openMenuFromKeyboard();
  };
  const openMenuAt = (x: number, y: number) => {
    if (!onArchiveSession) return;
    setMenuAnchor({ x, y });
    setIsMenuOpen(true);
  };
  const openMenuFromKeyboard = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenuAt(rect.right - 164, rect.top + 8);
  };
  const openMenuFromContext = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onArchiveSession) return;
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY);
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
      onContextMenu={openMenuFromContext}
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
            <>
              {row.locationInfo ? (
                <span className="vela-session-location" title={row.locationInfo.path}>
                  <Folder size={12} strokeWidth={2.1} aria-hidden="true" />
                  <span>{row.locationInfo.label}</span>
                </span>
              ) : null}
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
            </>
          ) : (
            <>
              <span className="vela-session-preview">{row.previewLabel}</span>
              {row.locationInfo ? (
                <span className="vela-session-location" title={row.locationInfo.path}>
                  <Folder size={12} strokeWidth={2.1} aria-hidden="true" />
                  <span>{row.locationInfo.label}</span>
                </span>
              ) : (
                <span className="vela-session-meta">{row.metaLabel}</span>
              )}
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
            className="vela-session-archive-action"
            type="button"
            aria-label={row.archiveActionLabel}
            onClick={(event) => {
              event.stopPropagation();
              void archiveSession();
            }}
          >
            <ArchiveGlyph />
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
