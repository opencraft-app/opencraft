import type { BotRepository } from "@/repositories/types";
import {
  JSON_END,
  JSON_START,
  buildHermesAchievementsCommand,
} from "@/pages/marketing/openclaw-achievements-command";
import { isExecCommandSucceeded, truncateExecOutput } from "@/pages/marketing/openclaw-reset-config";

export { JSON_END, JSON_START, buildHermesAchievementsCommand } from "@/pages/marketing/openclaw-achievements-command";

export type AchievementState = "unlocked" | "discovered" | "secret";

export interface AchievementEvidence {
  session_id?: string;
  title?: string;
  value?: number;
}

export interface HermesAchievement {
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  state: AchievementState;
  unlocked: boolean;
  tier?: string | null;
  next_tier?: string | null;
  progress?: number;
  progress_pct?: number;
  next_threshold?: number | null;
  criteria?: string;
  unlocked_at?: number | null;
  evidence?: AchievementEvidence | null;
}

export interface AchievementScanStatus {
  state?: string;
  started_at?: number | null;
  finished_at?: number | null;
  last_error?: string | null;
  last_duration_ms?: number | null;
  run_count?: number;
  ttl_seconds?: number;
  snapshot_generated_at?: number | null;
  snapshot_age_seconds?: number | null;
  snapshot_stale?: boolean;
}

export interface AchievementSnapshot {
  achievements: HermesAchievement[];
  unlocked_count: number;
  discovered_count: number;
  secret_count: number;
  total_count: number;
  generated_at?: number | null;
  is_stale?: boolean;
  error?: string | null;
  scan_meta?: {
    mode?: string;
    sessions_total?: number;
    sessions_rescanned?: number;
    sessions_reused?: number;
    sessions_scanned_so_far?: number;
    sessions_expected_total?: number;
    status?: AchievementScanStatus;
  };
}

export type AchievementPayloadErrorCode =
  | "command_failed"
  | "json_block_missing"
  | "json_parse_failed"
  | "payload_invalid";

export class AchievementPayloadError extends Error {
  readonly code: AchievementPayloadErrorCode;

  constructor(code: AchievementPayloadErrorCode, message: string) {
    super(message);
    this.name = "AchievementPayloadError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const toNumber = (value: unknown, fallback = 0) => (
  typeof value === "number" && Number.isFinite(value) ? value : fallback
);

const toString = (value: unknown, fallback = "") => (
  typeof value === "string" ? value : fallback
);

const toNullableNumber = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

const toAchievementState = (value: unknown, unlocked: boolean): AchievementState => {
  if (value === "unlocked" || value === "discovered" || value === "secret") {
    return value;
  }
  return unlocked ? "unlocked" : "discovered";
};

const normalizeEvidence = (value: unknown): AchievementEvidence | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    session_id: toString(value.session_id) || undefined,
    title: toString(value.title) || undefined,
    value: typeof value.value === "number" && Number.isFinite(value.value) ? value.value : undefined,
  };
};

const normalizeAchievement = (value: unknown): HermesAchievement | null => {
  if (!isRecord(value)) {
    return null;
  }

  const id = toString(value.id).trim();
  if (!id) {
    return null;
  }

  const unlocked = value.unlocked === true;
  const state = toAchievementState(value.state, unlocked);
  const fallbackName = state === "secret" ? "???" : id;

  return {
    id,
    name: toString(value.name, fallbackName),
    description: toString(value.description),
    category: toString(value.category, "Other"),
    icon: toString(value.icon) || undefined,
    state,
    unlocked,
    tier: typeof value.tier === "string" ? value.tier : null,
    next_tier: typeof value.next_tier === "string" ? value.next_tier : null,
    progress: toNumber(value.progress),
    progress_pct: toNumber(value.progress_pct, unlocked ? 100 : 0),
    next_threshold: toNullableNumber(value.next_threshold),
    criteria: toString(value.criteria) || undefined,
    unlocked_at: toNullableNumber(value.unlocked_at),
    evidence: normalizeEvidence(value.evidence),
  };
};

export const parseHermesAchievementsOutput = (output: string): AchievementSnapshot => {
  const startIndex = output.indexOf(JSON_START);
  const endIndex = output.indexOf(JSON_END);

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new AchievementPayloadError("json_block_missing", "Hermes achievements JSON block was not found.");
  }

  const jsonText = output.slice(startIndex + JSON_START.length, endIndex).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new AchievementPayloadError("json_parse_failed", error instanceof Error ? error.message : "Failed to parse achievements JSON.");
  }

  if (!isRecord(parsed)) {
    throw new AchievementPayloadError("payload_invalid", "Hermes achievements payload is not an object.");
  }

  const achievements = Array.isArray(parsed.achievements)
    ? parsed.achievements.map(normalizeAchievement).filter((item): item is HermesAchievement => item !== null)
    : [];

  const scanMeta = isRecord(parsed.scan_meta) ? parsed.scan_meta : undefined;
  const scanStatus = scanMeta && isRecord(scanMeta.status) ? scanMeta.status : undefined;

  return {
    achievements,
    unlocked_count: toNumber(parsed.unlocked_count, achievements.filter((item) => item.state === "unlocked").length),
    discovered_count: toNumber(parsed.discovered_count, achievements.filter((item) => item.state === "discovered").length),
    secret_count: toNumber(parsed.secret_count, achievements.filter((item) => item.state === "secret").length),
    total_count: toNumber(parsed.total_count, achievements.length),
    generated_at: toNullableNumber(parsed.generated_at),
    is_stale: parsed.is_stale === true,
    error: typeof parsed.error === "string" ? parsed.error : null,
    scan_meta: scanMeta
      ? {
          mode: toString(scanMeta.mode) || undefined,
          sessions_total: toNumber(scanMeta.sessions_total),
          sessions_rescanned: toNumber(scanMeta.sessions_rescanned),
          sessions_reused: toNumber(scanMeta.sessions_reused),
          sessions_scanned_so_far: toNumber(scanMeta.sessions_scanned_so_far),
          sessions_expected_total: toNumber(scanMeta.sessions_expected_total),
          status: scanStatus
            ? {
                state: toString(scanStatus.state) || undefined,
                started_at: toNullableNumber(scanStatus.started_at),
                finished_at: toNullableNumber(scanStatus.finished_at),
                last_error: typeof scanStatus.last_error === "string" ? scanStatus.last_error : null,
                last_duration_ms: toNullableNumber(scanStatus.last_duration_ms),
                run_count: toNumber(scanStatus.run_count),
                ttl_seconds: toNumber(scanStatus.ttl_seconds),
                snapshot_generated_at: toNullableNumber(scanStatus.snapshot_generated_at),
                snapshot_age_seconds: toNullableNumber(scanStatus.snapshot_age_seconds),
                snapshot_stale: scanStatus.snapshot_stale === true,
              }
            : undefined,
        }
      : undefined,
  };
};

export const fetchHermesAchievements = async (
  bots: BotRepository,
  botId: string,
  options: { forceRescan?: boolean } = {},
): Promise<AchievementSnapshot> => {
  const result = await bots.execDebugCommand(botId, buildHermesAchievementsCommand(options.forceRescan === true));
  if (!isExecCommandSucceeded(result)) {
    throw new AchievementPayloadError("command_failed", `Hermes achievements command failed: ${truncateExecOutput(result.output, result.status)}`);
  }
  return parseHermesAchievementsOutput(result.output);
};
