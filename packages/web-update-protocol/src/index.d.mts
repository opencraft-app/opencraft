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
  readonly updateAvailable: boolean;
  readonly execution: { readonly enabled: true; readonly profile?: 'daemon' | 'headless'; readonly version: string | null; readonly buildId: string | null; readonly ready: boolean; readonly observation?: { readonly reason: 'ready' | 'pointer-unavailable' | 'health-invalid' | 'dependency-unavailable' | 'health-http-error' | 'release-mismatch' | 'health-timeout' | 'health-unreachable'; readonly sampledAt: string; readonly durationMs: number } } | null;
  readonly packageName: string;
  readonly channel: string;
  readonly job: WebUpdateJob | null;
}
export function parseWebUpdateStatus(value: unknown): WebUpdateStatus;
export function parseWebReleaseMetadata(value: unknown): { schemaVersion: 1; workerProtocol: 1; buildId: string };
