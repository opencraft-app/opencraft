import type { SessionListItemWire } from "../../../vela-chat-client/src";

export interface SessionListSurfaceProps {
  sessions: SessionListItemWire[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

export function SessionListSurface({
  sessions,
  currentSessionId,
  onSelectSession,
}: SessionListSurfaceProps) {
  return (
    <ul className="vela-sidebar-menu session-list" data-sidebar="menu" data-slot="session-list-surface">
      {sessions.map((session) => (
        <SessionListSurfaceItem
          key={session.id}
          session={session}
          isActive={session.id === currentSessionId}
          onSelect={() => onSelectSession(session.id)}
        />
      ))}
    </ul>
  );
}

function SessionListSurfaceItem({
  session,
  isActive,
  onSelect,
}: {
  session: SessionListItemWire;
  isActive: boolean;
  onSelect: () => void;
}) {
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

  return (
    <li
      className={["vela-sidebar-menu-item vela-session-item", isActive ? "active" : ""]
        .filter(Boolean)
        .join(" ")}
      data-sidebar="menu-item"
      data-slot="session-list-surface-item"
      data-status={session.status}
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
    </li>
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
