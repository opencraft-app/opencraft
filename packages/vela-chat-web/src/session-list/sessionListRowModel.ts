import type { SessionListItemWire } from "../../../vela-chat-client/src";
import {
  buildSessionLocationInfo,
  type SessionLocationInfo,
} from "../session-location/sessionLocation";

export interface SessionListText {
  archiveChat: string;
  archiveChatForTitle: (title: string) => string;
  minuteRecency: (minutes: number) => string;
  hourRecency: (hours: number) => string;
  dayRecency: (days: number) => string;
}

export const defaultSessionListText: SessionListText = {
  archiveChat: "归档对话",
  archiveChatForTitle: (title) => `归档对话: ${title}`,
  minuteRecency: (minutes) => `${minutes}分`,
  hourRecency: (hours) => `${hours}时`,
  dayRecency: (days) => `${days}天`,
};

export type SessionListActivity = "idle" | "running" | "waiting_for_input" | "failed";
export type SessionListRailRecency = "minutes" | "hours" | "days";

export interface SessionListRailModel {
  label: string;
  recency: SessionListRailRecency;
}

export interface SessionListRowModel {
  id: string;
  title: string;
  previewLabel: string;
  metaLabel: string;
  locationInfo: SessionLocationInfo | null;
  rail: SessionListRailModel | null;
  archiveActionLabel: string;
  archiveMenuLabel: string;
  status: {
    activity: SessionListActivity;
    isRunning: boolean;
    isWaiting: boolean;
    isFailed: boolean;
  };
}

export interface BuildSessionListRowModelOptions {
  nowMs?: number;
  text?: SessionListText;
}

const sessionListRailFreshSuppressionMs = 10 * 60_000;

export function buildSessionListRowModel(
  session: SessionListItemWire,
  options: BuildSessionListRowModelOptions = {},
): SessionListRowModel {
  const text = options.text ?? defaultSessionListText;
  const projectedAttention = session.activity?.attention;
  const projectedPhase = session.activity?.phase;
  const isWaiting = session.activity
    ? projectedAttention === "waiting_for_user"
    : session.status === "waiting_for_input" || session.pending_request_count > 0;
  const isRunning =
    !isWaiting &&
    (session.activity
      ? projectedPhase === "starting" ||
        projectedPhase === "running" ||
        projectedPhase === "canceling"
      : session.running ||
        session.status === "starting" ||
        session.status === "running" ||
        session.status === "canceling");
  const isFailed = session.activity ? projectedAttention === "error" : session.status === "failed";
  const title = session.title || session.id;
  const locationInfo = buildSessionLocationInfo(session.working_directory);

  return {
    id: session.id,
    title,
    previewLabel: sessionPreviewLabel(session, locationInfo),
    metaLabel: sessionMetaLabel(session),
    locationInfo,
    rail: sessionRailModel(
      session.last_activity_at || session.updated_at,
      options.nowMs,
      text,
    ),
    archiveActionLabel: text.archiveChatForTitle(title),
    archiveMenuLabel: text.archiveChat,
    status: {
      activity: sessionListActivity({ isFailed, isRunning, isWaiting }),
      isRunning,
      isWaiting,
      isFailed,
    },
  };
}

function sessionListActivity({
  isFailed,
  isRunning,
  isWaiting,
}: {
  isFailed: boolean;
  isRunning: boolean;
  isWaiting: boolean;
}): SessionListActivity {
  if (isFailed) return "failed";
  if (isWaiting) return "waiting_for_input";
  if (isRunning) return "running";
  return "idle";
}

function sessionMetaLabel(session: SessionListItemWire) {
  const backend = session.backend;
  const model = session.agent_config?.model ?? session.model;
  return [backend, model].filter(Boolean).join(" · ");
}

function sessionPreviewLabel(
  session: SessionListItemWire,
  locationInfo: SessionLocationInfo | null,
) {
  const preview = session.preview.trim();
  if (preview) return preview;

  if (locationInfo) return locationInfo.label;

  return sessionMetaLabel(session);
}

function sessionRailModel(
  value: string,
  nowMs = Date.now(),
  text = defaultSessionListText,
): SessionListRailModel | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = Math.max(0, nowMs - timestamp);
  if (diffMs < sessionListRailFreshSuppressionMs) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return {
      label: text.minuteRecency(minutes),
      recency: "minutes",
    };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return {
      label: text.hourRecency(hours),
      recency: "hours",
    };
  }
  const days = Math.floor(hours / 24);
  return {
    label: text.dayRecency(days),
    recency: "days",
  };
}
