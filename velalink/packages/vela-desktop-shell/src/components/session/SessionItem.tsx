import { MessageSquareText } from "lucide-react";
import type { SessionListItemWire } from "../../../../vela-chat-client/src";
import { SidebarMenuButton, SidebarMenuItem } from "../sidebar";
import { sessionMetaLabel, sessionPreviewLabel, sessionRailLabel } from "./sessionLabels";

export interface SessionItemProps {
  session: SessionListItemWire;
  isActive: boolean;
  onSelect?: () => void;
}

export function SessionItem({ session, isActive, onSelect }: SessionItemProps) {
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
    <SidebarMenuItem
      className={["vela-session-item", isActive ? "active" : ""].filter(Boolean).join(" ")}
      data-status={session.status}
      data-running={isRunning ? "true" : undefined}
      data-waiting={isWaiting ? "true" : undefined}
      data-failed={isFailed ? "true" : undefined}
    >
      <SidebarMenuButton
        className="vela-session-main"
        isActive={isActive}
        size="compact"
        onClick={onSelect}
        disabled={!onSelect}
      >
        <span className="vela-session-icon" aria-hidden>
          <MessageSquareText size={14} />
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
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
