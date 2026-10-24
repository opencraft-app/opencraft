#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createProtocolIngress } from './protocol-ingress.mjs';
import { createManagedWebServer } from './server.mjs';
import { createExecutionDeployment } from '../server-deployment/execution.mjs';
const executionLink = process.env.OPENCRAFT_EXECUTION_LINK;
const execution = executionLink ? createExecutionDeployment({
  link: executionLink, unit: process.env.OPENCRAFT_EXECUTION_UNIT, coreUnit: process.env.OPENCRAFT_CODEX_CORE_UNIT,
  coreEndpoint: process.env.OPENCRAFT_CODEX_CORE_ENDPOINT, tokenPath: process.env.OPENCRAFT_DAEMON_TOKEN_FILE,
  healthUrl: process.env.OPENCRAFT_EXECUTION_HEALTH_URL,
  profile: process.env.OPENCRAFT_EXECUTION_PROFILE || 'daemon',
  dshDescriptor: process.env.OPENCRAFT_DSH_HOST_DESCRIPTOR,
  dshUnit: process.env.OPENCRAFT_DSH_HOST_UNIT,
}) : null;
const port = Number(process.env.OPENCRAFT_WEB_PORT || 10000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Web port');
const host = process.env.OPENCRAFT_WEB_HOST || '127.0.0.1';
const app = await createManagedWebServer({
  initialRelease: process.env.OPENCRAFT_WEB_RELEASE || resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  stateDirectory: process.env.OPENCRAFT_WEB_STATE || resolve(homedir(), '.local/share/opencraft/web'),
  execution,
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
  if (process.env.OPENCRAFT_HEADLESS_SSH_TARGET) {
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
