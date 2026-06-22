import type { SessionWire } from "../../../../packages/vela-chat-client/src";

export interface RecentSessionRow {
  id: string;
  title: string;
  backend: string;
  subtitle: string;
  updatedAt: string;
  status: string;
}

export function buildRecentSessionRows(sessions: readonly SessionWire[]): RecentSessionRow[] {
  return sessions.map((session) => ({
    id: session.id,
    title: session.title || session.id,
    backend: session.backend,
    subtitle: sessionSubtitle(session),
    updatedAt: formatRelativeSessionTime(session.updated_at),
    status: session.status,
  }));
}

function sessionSubtitle(session: SessionWire): string {
  const parts = [
    session.backend,
    session.agent_config?.model ?? session.model,
    compactPath(session.working_directory),
  ].filter(Boolean);
  return parts.join(" · ");
}

function compactPath(path: string) {
  if (!path) return "";
  const home =
    typeof process !== "undefined" && typeof process.env.HOME === "string"
      ? process.env.HOME
      : "";
  const normalized = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `${normalized.startsWith("/") ? "/" : ""}.../${parts.slice(-2).join("/")}`;
}

function formatRelativeSessionTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const deltaMs = Date.now() - timestamp;
  const absMs = Math.abs(deltaMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (absMs < minute) return "just now";
  if (absMs < hour) return `${Math.max(1, Math.round(absMs / minute))}m ago`;
  if (absMs < day) return `${Math.round(absMs / hour)}h ago`;
  return `${Math.round(absMs / day)}d ago`;
}
