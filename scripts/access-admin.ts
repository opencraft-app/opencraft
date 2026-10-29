#!/usr/bin/env node
import { MembershipStore } from '../packages/access-control/src/index.js';
import { isAbsolute, dirname, basename } from 'node:path';
import { openServerDatabase } from "../packages/storage-node/src/server/index.js";
import { ActorStore } from '../packages/access-control/src/actors.js';
const [database, action, provider, subject, role = 'member'] = process.argv.slice(2);
if (!database || !isAbsolute(database) || !['opencraft-server.sqlite', 'memberships.sqlite'].includes(basename(database)) || !['list', 'list-actors', 'audit', 'grant', 'revoke'].includes(action ?? '')) throw new Error('Usage: access-admin /absolute/opencraft-server.sqlite list|list-actors|audit|grant|revoke [provider subject [admin|member]]');
const storage = await openServerDatabase(dirname(database));
const store = new MembershipStore(storage);
const actors = new ActorStore(storage);
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
} finally { actors?.close(); store.close(); await storage.close(); }
