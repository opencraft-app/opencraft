const PENDING_SCENARIO_INSTALL_KEY = "lightvela-pending-scenario-install-v1";
const PENDING_SCENARIO_INSTALL_TTL_MS = 30 * 60 * 1000;

export interface PendingScenarioInstall {
  scenarioId: string;
  values: Record<string, string>;
  userPrompt: string;
  deliver: string;
  skill?: string;
  createdAt: string;
}

type PendingScenarioInstallInput = Omit<PendingScenarioInstall, "createdAt">;

function getScenarioInstallStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function savePendingScenarioInstall(
  input: PendingScenarioInstallInput,
  now = new Date(),
): PendingScenarioInstall {
  const pending: PendingScenarioInstall = { ...input, createdAt: now.toISOString() };
  getScenarioInstallStorage()?.setItem(PENDING_SCENARIO_INSTALL_KEY, JSON.stringify(pending));
  return pending;
}

export function readPendingScenarioInstall(now = new Date()): PendingScenarioInstall | null {
  const storage = getScenarioInstallStorage();
  const raw = storage?.getItem(PENDING_SCENARIO_INSTALL_KEY);
  if (!raw) return null;
  try {
    const candidate = JSON.parse(raw) as Partial<PendingScenarioInstall>;
    const createdAtMs = Date.parse(candidate.createdAt ?? "");
    const valid = typeof candidate.scenarioId === "string"
      && typeof candidate.userPrompt === "string"
      && typeof candidate.deliver === "string"
      && (candidate.skill === undefined || typeof candidate.skill === "string")
      && candidate.values !== null
      && typeof candidate.values === "object"
      && Number.isFinite(createdAtMs)
      && now.getTime() - createdAtMs <= PENDING_SCENARIO_INSTALL_TTL_MS;
    if (!valid) {
      storage?.removeItem(PENDING_SCENARIO_INSTALL_KEY);
      return null;
    }
    return candidate as PendingScenarioInstall;
  } catch {
    storage?.removeItem(PENDING_SCENARIO_INSTALL_KEY);
    return null;
  }
}

export function clearPendingScenarioInstall(): void {
  getScenarioInstallStorage()?.removeItem(PENDING_SCENARIO_INSTALL_KEY);
}

export function getPostAgentCreationPath(defaultPath: string): string {
  return readPendingScenarioInstall() ? "/" : defaultPath;
}
