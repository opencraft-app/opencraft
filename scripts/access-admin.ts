#!/usr/bin/env node
import { MembershipStore } from '../packages/access-control/src/index.js';
import { isAbsolute, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { ActorStore } from '../packages/access-control/src/actors.js';
const [database, action, provider, subject, role = 'member'] = process.argv.slice(2);
if (!database || !isAbsolute(database) || !['list', 'list-actors', 'audit', 'grant', 'revoke'].includes(action ?? '')) throw new Error('Usage: access-admin /absolute/memberships.sqlite list|list-actors|audit|grant|revoke [provider subject [admin|member]]');
const store = new MembershipStore(database);
const actorPath = join(dirname(database), 'actors.sqlite');
const actors = existsSync(actorPath) ? new ActorStore(actorPath) : null;
try {
  if (action === 'list') console.log(JSON.stringify(store.list(), null, 2));
  else if (action === 'list-actors') console.log(JSON.stringify(store.listActors(), null, 2));
  else if (action === 'audit') console.log(JSON.stringify(store.audit(), null, 2));
  else {
    if (!provider || !subject || !['admin', 'member'].includes(role)) throw new Error('provider, stable subject and valid role required');
    store.set({ provider, subject }, role as 'admin' | 'member', action === 'grant', 'local-operator');
    const actor = actors?.findHuman({ provider, subject });
    if (actor) store.setActor(actor.id, role as 'admin' | 'member', action === 'grant', 'local-operator');
    console.log('Membership updated');
  }
} finally { actors?.close(); store.close(); }
