export const WEB_UPDATE_PATH = '/__opencraft_updates';
export const WEB_WORKER_PROTOCOL = 1;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => object(value) && typeof value.version === 'string' && typeof value.buildId === 'string';
const observation = value => value === undefined || (object(value)
  && ['ready', 'pointer-unavailable', 'health-invalid', 'dependency-unavailable', 'health-http-error', 'release-mismatch', 'health-timeout', 'health-unreachable'].includes(value.reason)
  && typeof value.sampledAt === 'string' && Number.isFinite(Date.parse(value.sampledAt))
  && Number.isFinite(value.durationMs) && value.durationMs >= 0);
const nullableString = value => value === null || typeof value === 'string';
export function parseWebUpdateStatus(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.enabled !== true
    || !(value.localInstall === undefined || typeof value.localInstall === 'boolean')
    || typeof value.authenticated !== 'boolean' || !identity(value.current)
    || !(value.latest === null || identity(value.latest)) || typeof value.checking !== 'boolean'
    || !nullableString(value.checkedAt) || !nullableString(value.checkError)
    || !(value.checkErrorCode == null || ['authentication', 'network', 'unavailable', 'registry'].includes(value.checkErrorCode))
    || typeof value.canRollback !== 'boolean' || typeof value.updateAvailable !== 'boolean'
    || !(value.execution == null || (object(value.execution) && value.execution.enabled === true && nullableString(value.execution.version) && nullableString(value.execution.buildId) && typeof value.execution.ready === 'boolean' && observation(value.execution.observation) && (value.execution.profile === undefined || ['daemon', 'headless'].includes(value.execution.profile))))
    || typeof value.packageName !== 'string' || typeof value.channel !== 'string'
    || !(value.job === null || (object(value.job) && typeof value.job.id === 'string'
      && typeof value.job.version === 'string' && ['downloading', 'verifying', 'starting', 'completed', 'failed'].includes(value.job.phase)
      && nullableString(value.job.error)))) throw new Error('Invalid Web update response');
  return {
    schemaVersion: 1, enabled: true, localInstall: value.localInstall ?? false, authenticated: value.authenticated,
    current: { version: value.current.version, buildId: value.current.buildId },
    latest: value.latest === null ? null : { version: value.latest.version, buildId: value.latest.buildId },
    checking: value.checking, checkedAt: value.checkedAt, checkError: value.checkError, checkErrorCode: value.checkErrorCode ?? null,
    canRollback: value.canRollback, updateAvailable: value.updateAvailable,
    execution: value.execution == null ? null : { enabled: true, version: value.execution.version, buildId: value.execution.buildId, ready: value.execution.ready, ...(value.execution.observation === undefined ? {} : { observation: { ...value.execution.observation } }), ...(value.execution.profile === undefined ? {} : { profile: value.execution.profile }) },
    packageName: value.packageName, channel: value.channel,
    job: value.job === null ? null : { id: value.job.id, version: value.job.version, phase: value.job.phase, error: value.job.error },
  };
}

export function parseWebReleaseMetadata(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.workerProtocol !== WEB_WORKER_PROTOCOL
    || typeof value.buildId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.buildId))
    throw new Error('Incompatible Web release');
  return { schemaVersion: 1, workerProtocol: WEB_WORKER_PROTOCOL, buildId: value.buildId };
}
