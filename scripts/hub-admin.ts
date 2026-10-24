#!/usr/bin/env node
import { resolve } from 'node:path';
import { readPrivateJson } from '../packages/identity-core/src/node.js';
import { HubNetwork } from '../packages/hub-network/src/node.js';

// Offline machine-owner recovery/bootstrap. The running owner holds an exclusive
// state lock; this command never races or impersonates a browser administrator.
const [statePath, commandFile] = process.argv.slice(2);
if (!statePath || statePath !== resolve(statePath)) throw new Error('Usage: hub-admin /absolute/hub-network.json [/absolute/private-command.json]');
const input = commandFile ? await readPrivateJson(commandFile) as Record<string, unknown> : null;
const node = new HubNetwork(statePath);
try {
  if (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Hub command');
    console.log(JSON.stringify(node.command({ ...input, revision: node.store.state.revision }, 'local-operator')));
  } else console.log(JSON.stringify(node.snapshot()));
} finally { node.close(); }
