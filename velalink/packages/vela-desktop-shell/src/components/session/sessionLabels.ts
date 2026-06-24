import type { SessionListItemWire } from "../../../../vela-chat-client/src";

export function sessionMetaLabel(session: SessionListItemWire) {
  const backend = session.backend;
  const model = session.agent_config?.model ?? session.model;
  return [backend, model].filter(Boolean).join(" · ");
}

export function sessionPreviewLabel(session: SessionListItemWire) {
  const preview = session.preview.trim();
  if (preview) return preview;

  const cwd = session.working_directory.trim();
  if (cwd) return cwd.split("/").filter(Boolean).at(-1) ?? cwd;

  return sessionMetaLabel(session);
}

export function sessionRailLabel(session: SessionListItemWire) {
  return relativeSessionTime(session.last_activity_at || session.updated_at);
}

export function relativeSessionTime(value: string) {
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
