export type MobileScheduleDraft =
  | { mode: "keep"; source: string; label: string }
  | { mode: "daily"; time: string }
  | { mode: "interval"; count: string; unit: "h" | "d" }
  | { mode: "once"; date: string; time: string };

export function localDateTomorrow(now = new Date()): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
}

export function initialMobileSchedule(source?: string, label?: string): MobileScheduleDraft {
  if (source) {
    const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(source.trim());
    if (daily && +daily[1]! < 60 && +daily[2]! < 24) return { mode: "daily", time: `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}` };
    const interval = /^every\s+(\d+)([hd])$/i.exec(source.trim());
    if (interval) return { mode: "interval", count: interval[1]!, unit: interval[2]!.toLowerCase() as "h" | "d" };
    const once = new Date(source);
    if (Number.isFinite(once.getTime()) && /\d{4}-\d{2}-\d{2}/.test(source)) return {
      mode: "once", date: `${once.getFullYear()}-${String(once.getMonth() + 1).padStart(2, "0")}-${String(once.getDate()).padStart(2, "0")}`,
      time: `${String(once.getHours()).padStart(2, "0")}:${String(once.getMinutes()).padStart(2, "0")}`,
    };
    return { mode: "keep", source, label: label ?? source };
  }
  return { mode: "daily", time: "09:00" };
}

export function buildMobileSchedule(draft: MobileScheduleDraft, now = new Date()): string | null {
  if (draft.mode === "keep") return draft.source;
  if (draft.mode === "daily") {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(draft.time.trim());
    return match ? `${+match[2]!} ${+match[1]!} * * *` : null;
  }
  if (draft.mode === "interval") {
    const count = Number(draft.count);
    return Number.isSafeInteger(count) && count > 0 && count <= (draft.unit === "h" ? 168 : 365)
      ? `every ${count}${draft.unit}` : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return null;
  const local = new Date(`${draft.date}T${draft.time}:00`);
  if (!Number.isFinite(local.getTime()) || local.getTime() <= now.getTime()) return null;
  const [year, month, day] = draft.date.split("-").map(Number);
  if (local.getFullYear() !== year || local.getMonth() + 1 !== month || local.getDate() !== day) return null;
  return local.toISOString();
}
