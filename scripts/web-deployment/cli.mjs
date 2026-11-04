#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createProtocolIngress } from './protocol-ingress.mjs';
import { installedUpgradeConfig } from './full-upgrade.mjs';
import { createManagedWebServer } from './server.mjs';
import { createExecutionDeployment } from '../server-deployment/execution.mjs';
import { prepareResidentWorker } from './resident-worker.mjs';
const rollbackCommand = process.env.OPENCRAFT_ROLLBACK_RECOVERY_COMMAND
  ? JSON.parse(process.env.OPENCRAFT_ROLLBACK_RECOVERY_COMMAND) : null;
if (rollbackCommand && (!Array.isArray(rollbackCommand) || !rollbackCommand.length
  || !rollbackCommand.every(arg => typeof arg === 'string' && arg.length > 0)))
  throw new Error('Invalid rollback recovery command');
const executionLink = process.env.OPENCRAFT_EXECUTION_LINK;
const execution = executionLink ? createExecutionDeployment({
  link: executionLink, unit: process.env.OPENCRAFT_EXECUTION_UNIT, coreUnit: process.env.OPENCRAFT_CODEX_CORE_UNIT,
  coreEndpoint: process.env.OPENCRAFT_CODEX_CORE_ENDPOINT, tokenPath: process.env.OPENCRAFT_DAEMON_TOKEN_FILE,
  healthUrl: process.env.OPENCRAFT_EXECUTION_HEALTH_URL,
  profile: process.env.OPENCRAFT_EXECUTION_PROFILE || 'daemon',
  dshDescriptor: process.env.OPENCRAFT_DSH_HOST_DESCRIPTOR,
  dshUnit: process.env.OPENCRAFT_DSH_HOST_UNIT,
  engineDescriptor: process.env.OPENCRAFT_ENGINE_HOST_DESCRIPTOR,
  engineUnit: process.env.OPENCRAFT_ENGINE_HOST_UNIT,
}) : null;
if (process.argv[2] === '--prepare-restart') {
  if (process.argv.length !== 3 || !execution) throw new Error('Restart preparation requires configured managed execution');
  // Run from the verified candidate while the old entry is still online.
  // This observes the existing gateway; it never applies or restarts it.
  const status = await execution.status();
  if (!status.ready) throw new Error('Existing execution is not ready for entry restart');
  console.log('[opencraft web] restart preparation complete');
  process.exit(0);
}
const port = Number(process.env.OPENCRAFT_WEB_PORT || 10000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Web port');
const host = process.env.OPENCRAFT_WEB_HOST || '127.0.0.1';
const webState = process.env.OPENCRAFT_WEB_STATE || resolve(homedir(), '.local/share/opencraft/web');
const residency = process.env.OPENCRAFT_RESIDENT_ENTRY_CHILD === '1' ? await prepareResidentWorker(async () => {
  // A cold resident must retain the normal interrupted-install recovery path.
  // Hot activation enforces readiness read-only after the authority handoff.
  if (execution) await execution.status().catch(() => null);
}) : null;
const app = await createManagedWebServer({
  administratorState: residency?.administratorState ?? null,
  reconcileExecutionOnStartup: residency?.reconcileExecution !== false,
  upgradeConfigPath: await installedUpgradeConfig(webState),
  initialRelease: process.env.OPENCRAFT_WEB_RELEASE || resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  stateDirectory: process.env.OPENCRAFT_WEB_STATE || resolve(homedir(), '.local/share/opencraft/web'),
  execution,
  recoveryMarker: process.env.OPENCRAFT_RECOVERY_MAINTENANCE_MARKER || null,
  rollbackRecovery: rollbackCommand ? async () => {
    // A deployment-owned hook: no shell, only the configured managed control.
    // Do not reflect command output (which may contain private diagnostics).
    try { await promisify(execFile)(rollbackCommand[0], rollbackCommand.slice(1), { timeout: 120000, maxBuffer: 65536 }); }
    catch { throw new Error('Managed rollback connection recovery failed'); }
  } : null,
  headlessBackendTarget: process.env.OPENCRAFT_HEADLESS_BACKEND_URL || null,
  relayIngressTarget: process.env.OPENCRAFT_RELAY_INGRESS_URL || null,
  relayInternalPort: process.env.OPENCRAFT_RELAY_INTERNAL_PORT ? Number(process.env.OPENCRAFT_RELAY_INTERNAL_PORT) : null,
  localAccessFile: process.env.OPENCRAFT_LOCAL_ACCESS_FILE || null,
  registry: process.env.OPENCRAFT_NPM_REGISTRY,
  channel: process.env.OPENCRAFT_UPDATE_CHANNEL,
  userconfig: process.env.OPENCRAFT_NPM_USERCONFIG,
  publicOrigin: process.env.OPENCRAFT_PUBLIC_ORIGIN,
  appServerTarget: process.env.OPENCRAFT_APPSERVER_URL || null,
  codexServerTarget: process.env.OPENCRAFT_CODEX_APPSERVER_URL || null,
  hyperNodeUser: process.env.OPENCRAFT_HYPERNODE_USER || '',
});
let ingress;
let address;
try {
  if (residency) {
    // Initialize Node's normal HTTP parser deadlines on private ephemeral
    // listeners. Only the resident owns the configured public/Relay ports.
    await app.listen({ host: '127.0.0.1', port: 0, internalPort: 0 });
    if (process.env.OPENCRAFT_HEADLESS_SSH_TARGET) {
      if (!process.env.OPENCRAFT_HEADLESS_BACKEND_URL) throw new Error('SSH ingress requires a Headless backend');
      ingress = createProtocolIngress({ httpServer: app.server, sshTarget: process.env.OPENCRAFT_HEADLESS_SSH_TARGET });
    }
    address = { port };
  } else if (process.env.OPENCRAFT_HEADLESS_SSH_TARGET) {
    if (!process.env.OPENCRAFT_HEADLESS_BACKEND_URL) throw new Error('SSH ingress requires a Headless backend');
    const privateAddress = await app.listen({ host: '127.0.0.1', port: 0 });
    ingress = createProtocolIngress({ httpPort: privateAddress.port, httpServer: app.server, sshTarget: process.env.OPENCRAFT_HEADLESS_SSH_TARGET });
    address = await ingress.listen({ host, port });
  } else address = await app.listen({ host, port });
} catch (error) { await ingress?.close(); await app.close(); throw error; }
console.log(`[opencraft web] http://${host}:${address.port}`);
console.log(`[opencraft web] deployment administrator key file: ${app.adminKeyPath}`);
let stopping = false;
const shutdown = async () => { if (stopping) return; stopping = true; await ingress?.close(); await app.close(); process.exit(0); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
residency?.ready(app, ingress, async () => { await ingress?.close(); await app.close(); });
