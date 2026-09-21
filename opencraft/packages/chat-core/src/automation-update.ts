import type { AutomationUpdateTimelineBlock } from "./timeline";

export interface AutomationUpdatePresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly actionLabel: "Created" | "Updated" | "Deleted" | "Missing" | "Proposed" | "Proposed update" | "Scheduled task";
  readonly scheduleLabel: string | null;
  readonly canOpen: boolean;
}

function titleCaseIdentifier(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f-]+$/iu.test(value)) return value;
  return value.replace(/[-_]+/gu, " ").replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function actionLabel(block: AutomationUpdateTimelineBlock): AutomationUpdatePresentation["actionLabel"] {
  const mode = block.resultMode ?? block.mode;
  if (mode === "create") return "Created";
  if (mode === "update") return "Updated";
  if (mode === "delete") return block.deleteStatus === "not_found" ? "Missing" : "Deleted";
  if (mode === "suggested-create") return "Proposed";
  if (mode === "suggested-update") return "Proposed update";
  return "Scheduled task";
}

function clockLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

const WEEKDAY_LABELS: Readonly<Record<string, string>> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

/** Compact fallback for the same RRULE slot occupied by Codex's locale formatter. */
export function formatAutomationSchedule(rrule: string | null): string | null {
  if (rrule === null || rrule.trim().length === 0) return null;
  const fields = new Map(rrule.split(";").map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key?.toLocaleUpperCase() ?? "", rest.join("=")];
  }));
  const frequency = fields.get("FREQ")?.toLocaleUpperCase();
  const interval = Number.parseInt(fields.get("INTERVAL") ?? "1", 10);
  const hour = Number.parseInt(fields.get("BYHOUR") ?? "", 10);
  const minute = Number.parseInt(fields.get("BYMINUTE") ?? "0", 10);
  const time = Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59
    ? clockLabel(hour, minute)
    : null;
  if (frequency === "MINUTELY") return Number.isFinite(interval) && interval > 1 ? `Every ${interval} minutes` : "Every minute";
  if (frequency === "HOURLY") return Number.isFinite(interval) && interval > 1 ? `Every ${interval} hours` : "Every hour";
  if (frequency === "DAILY") return time === null ? "Every day" : `Every day at ${time}`;
  if (frequency === "WEEKLY") {
    const days = (fields.get("BYDAY") ?? "").split(",").map((day) => WEEKDAY_LABELS[day.trim().toLocaleUpperCase()]).filter((day): day is string => day !== undefined);
    const dayLabel = days.length === 0 ? "Every week" : days.length === 1 ? `Every ${days[0]}` : `Every ${days.join(", ")}`;
    return time === null ? dayLabel : `${dayLabel} at ${time}`;
  }
  return "Custom schedule";
}

export function presentAutomationUpdate(block: AutomationUpdateTimelineBlock): AutomationUpdatePresentation {
  const resultMode = block.resultMode ?? block.mode;
  const deleted = resultMode === "delete";
  const resolvedName = block.name ?? block.snapshot?.name ?? (deleted && block.automationId !== null ? titleCaseIdentifier(block.automationId) : null);
  const scheduleLabel = deleted ? null : formatAutomationSchedule(block.rrule ?? block.snapshot?.rrule ?? null);
  const action = actionLabel(block);
  return {
    title: resolvedName ?? "Untitled scheduled task",
    subtitle: scheduleLabel ?? action,
    actionLabel: action,
    scheduleLabel,
    canOpen: !deleted && (block.automationId !== null || block.mode === "create" || block.mode === "suggested-create"),
  };
}
