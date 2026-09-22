/** Same-tab refresh recovery. Never restore a snapshot into an unverified Bot. */
import type { SetupStep } from "@/pages/marketing/agent-buddy-setup";
import type { SetupStepState } from "@/pages/marketing/agent-buddy-setup-runner";

const STORAGE_KEY = "lv-buddy-setup-progress:";
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;

export interface BuddySetupSnapshot {
  botId: string;
  profileId: string;
  profile: { name: string; description: string };
  avatar: { shapeId: string; color: string };
  templateId: string;
  preserveSoul: boolean;
  planSignature: string;
  completedKeys: string[];
  updatedAt: number;
}

export const buildSetupStepKey = (step: SetupStep, index: number): string => `${index}:${step.kind}`;

// SOUL backup names contain a timestamp and cloned SOUL content may change after writing.
// All other commands are stable: changes to skills/routines must invalidate old progress.
export const buildSetupPlanSignature = (steps: SetupStep[]): string => JSON.stringify(
  steps.map((step) => [step.kind, step.kind === "soul" ? "" : step.command]),
);

const isSnapshot = (value: unknown): value is BuddySetupSnapshot => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BuddySetupSnapshot>;
  return typeof candidate.botId === "string" && candidate.botId.length > 0
    && typeof candidate.profileId === "string"
    && typeof candidate.profile?.name === "string"
    && typeof candidate.profile?.description === "string"
    && typeof candidate.avatar?.shapeId === "string"
    && typeof candidate.avatar?.color === "string"
    && typeof candidate.templateId === "string"
    && typeof candidate.preserveSoul === "boolean"
    && typeof candidate.planSignature === "string"
    && Array.isArray(candidate.completedKeys)
    && candidate.completedKeys.every((key) => typeof key === "string")
    && typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt);
};

export const loadBuddySetupSnapshot = (botId?: string): BuddySetupSnapshot | null => {
  if (typeof window === "undefined" || !botId) return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY + botId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSnapshot(parsed) || parsed.botId !== botId) return null;
    const age = Date.now() - parsed.updatedAt;
    if (age < 0 || age > SNAPSHOT_TTL_MS) {
      window.sessionStorage.removeItem(STORAGE_KEY + botId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const saveBuddySetupSnapshot = (snapshot: Omit<BuddySetupSnapshot, "updatedAt">): void => {
  if (typeof window === "undefined" || !snapshot.botId) return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY + snapshot.botId,
      JSON.stringify({ ...snapshot, updatedAt: Date.now() }),
    );
  } catch {
    // Storage is an enhancement; unavailable storage must not break creation.
  }
};

export const clearBuddySetupSnapshot = (botId: string): void => {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY + botId);
  } catch {
    // Storage can be disabled by browser policy.
  }
};

export const collectCompletedKeys = (states: SetupStepState[]): string[] => states.flatMap(
  (state, index) => state.status === "done" ? [buildSetupStepKey(state.step, index)] : [],
);

export const hasUnfinishedBuddySetup = (botId?: string): boolean => loadBuddySetupSnapshot(botId) !== null;
