#!/usr/bin/env node
import { readConfig, socketPath } from './service-config.mjs';
import { request } from './ipc.mjs';
import { invariant } from './durable.mjs';
let [socket, action, operationId, role, artifactId] = process.argv.slice(2);
if (socket === '--config') {
  const config = await readConfig(action);
  socket = socketPath(config, 'agent');
  invariant(operationId === 'reconcile' && role && !artifactId, 'expected-reconcile-job');
  operationId = role; role = undefined; action = 'page-reconcile';
}
invariant(socket && action && process.argv.length <= 7, 'expected-socket-action-operation-role-artifact');
request(socket, { action, ...(operationId ? { operationId } : {}), ...(role ? { role } : {}), ...(artifactId ? { artifactId } : {}) }, 120000)
  .then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n'))
  .catch(() => { process.stderr.write('upgrade control request failed\n'); process.exitCode = 1; });
