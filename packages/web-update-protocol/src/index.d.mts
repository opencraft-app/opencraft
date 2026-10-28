export const WEB_UPDATE_PATH: '/__opencraft_updates';
export const WEB_WORKER_PROTOCOL: 1;
export interface WebReleaseIdentity { readonly version: string; readonly buildId: string }
export interface WebUpdateJob {
  readonly id: string;
  readonly version: string;
  readonly phase: 'downloading' | 'verifying' | 'starting' | 'completed' | 'failed';
  readonly error: string | null;
}
export interface WebUpdateStatus {
  readonly schemaVersion: 1;
  readonly enabled: true;
  readonly localInstall: boolean;
  readonly authenticated: boolean;
  readonly current: WebReleaseIdentity;
  readonly latest: WebReleaseIdentity | null;
  readonly checking: boolean;
  readonly checkedAt: string | null;
  readonly checkError: string | null;
  readonly checkErrorCode: 'authentication' | 'network' | 'unavailable' | 'registry' | null;
  readonly canRollback: boolean;
  readonly recoveryRequired?: boolean;
  readonly recovery?: { readonly maintenanceMarker: boolean; readonly rollbackHook: boolean };
  readonly updateAvailable: boolean;
  readonly execution: { readonly enabled: true; readonly profile?: 'daemon' | 'headless'; readonly version: string | null; readonly buildId: string | null; readonly ready: boolean; readonly observation?: { readonly reason: 'ready' | 'pointer-unavailable' | 'health-invalid' | 'dependency-unavailable' | 'health-http-error' | 'release-mismatch' | 'health-timeout' | 'health-unreachable'; readonly sampledAt: string; readonly durationMs: number } } | null;
  readonly packageName: string;
  readonly channel: string;
  readonly job: WebUpdateJob | null;
}
export function parseWebUpdateStatus(value: unknown): WebUpdateStatus;
export function parseWebReleaseMetadata(value: unknown): { schemaVersion: 1; workerProtocol: 1; buildId: string };

export type UpgradeState = 'queued' | 'checking' | 'downloading' | 'prepared' | 'switching' | 'active-draining' | 'completed' | 'deferred' | 'failed' | 'rolling-back' | 'rolled-back' | 'recovery-required' | 'blocked';
export interface FullUpgradePlan {
  readonly planId: string | null; readonly planDigest: string | null;
  readonly status: 'blocked'; readonly executable: false;
  readonly releaseId: string | null; readonly sourceRevision: string | null;
  readonly channel: string | null; readonly manifestSha256: string | null;
  readonly downloadBytes: number | null;
  readonly blockedReasons: readonly string[];
  readonly components: readonly { componentId: string; role: string; targetVersion: string; runningVersion: string | null; installedVersion: string | null; nextStartVersion: string | null; state: UpgradeState; impact: string; blockedReasons: readonly string[] }[];
}
export interface FullUpgradeJob {
  readonly jobId: string; readonly planDigest: string; readonly state: UpgradeState;
  readonly releaseId: string | null; readonly targetVersion: string | null; readonly targetBuildId: string | null;
  readonly startedAt: string | null; readonly finishedAt: string | null;
  readonly stopRequested: boolean; readonly reason: string | null; readonly recoveryCommand: string | null;
  readonly components: readonly { componentId: string; state: UpgradeState; childJobId: string | null; affectedCount: number | null; healthy: boolean | null }[];
}
export interface FullUpgradeStatus {
  readonly schemaVersion: 1; readonly fullStackExecutable: false;
  readonly unavailable?: boolean; readonly plan: FullUpgradePlan | null; readonly jobs: readonly FullUpgradeJob[];
}
export function parseFullUpgradeStatus(value: unknown): FullUpgradeStatus;
