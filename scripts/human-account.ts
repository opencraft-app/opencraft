#!/usr/bin/env node
import { isAbsolute, join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { ActorStore } from '../packages/access-control/src/actors.js';
import { HumanAccounts } from '../packages/access-control/src/human-accounts.js';
import { LocalAccountServerPlugin } from '../plugins/local-account/src/server.js';
import { MembershipStore, type MemberRole } from '../packages/access-control/src/index.js';
import { readPrivateJson } from '../packages/identity-core/src/node.js';

const [directory, action, username, argument] = process.argv.slice(2);
const usage = 'Usage: human-account /absolute/server-data create|password USER /absolute/private-password.json; enable|disable USER; grant USER admin|member; revoke USER';
if (!directory || !isAbsolute(directory) || !username || !['create', 'password', 'enable', 'disable', 'grant', 'revoke'].includes(action ?? '')) throw new Error(usage);
await mkdir(directory, { recursive: true, mode: 0o700 });
const info = await stat(directory);
if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Server data directory must be owned and private');
const actors = new ActorStore(join(directory, 'actors.sqlite'));
const accounts = new HumanAccounts(join(directory, 'human-logins.sqlite'), actors);
const localAccounts = new LocalAccountServerPlugin(accounts.localAccountRepository);
accounts.registerLocalAccounts(localAccounts);
let members: MembershipStore | undefined;
try {
  if (action === 'create' || action === 'password') {
    if (!argument) throw new Error(usage);
    const input = await readPrivateJson(argument);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
      || typeof (input as { password?: unknown }).password !== 'string') throw new Error('Private password JSON must contain only a password string');
    const password = (input as { password: string }).password;
    if (action === 'create') await localAccounts.create(username, username, password);
    else await localAccounts.resetPassword(username, password);
    console.log(action === 'create' ? 'Local account created; no instance membership granted.' : 'Password updated; previous local browser sessions revoked.');
  } else if (action === 'enable' || action === 'disable') {
    localAccounts.setEnabled(username, action === 'enable'); console.log('Local account state updated; previous local browser sessions revoked.');
  } else {
    if (action === 'grant' && !['admin', 'member'].includes(argument ?? '')) throw new Error(usage);
    const identity = localAccounts.identity(username);
    if (!identity) throw new Error('Enabled local account required');
    const actor = actors.resolveHuman(identity);
    if (!actor) throw new Error('Human Actor unavailable');
    members = new MembershipStore(join(directory, 'memberships.sqlite'));
    members.setActor(actor.actorId, action === 'grant' ? argument as MemberRole : 'member', action === 'grant', 'local-operator');
    console.log('Actor instance membership updated.');
  }
} finally { members?.close(); accounts.close(); actors.close(); }
