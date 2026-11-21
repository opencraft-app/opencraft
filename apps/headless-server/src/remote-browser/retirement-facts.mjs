import { createHash } from 'node:crypto';
/** Minimal resource identities are permanent. Bounded operation receipts do
 * not own the lifetime of metadata anti-resurrection facts. */
export function recordRetirementFacts(state, { key, ownerId, lease, pageIds = [], tabIds = [] }, index) {
  state.retiredResources ??= [];
  let fact = index ? index.get(key) : state.retiredResources.get ? state.retiredResources.get(key) : state.retiredResources.find(entry => entry.key === key);
  if (!fact) { fact = { key, ownerId, lease, pageIds: [], tabIds: [] }; state.retiredResources.push(fact); index?.set(key, fact); }
  fact.pageIds = [...new Set([...fact.pageIds, ...pageIds])];
  fact.tabIds = [...new Set([...fact.tabIds, ...tabIds])];
}

export function initializeRetirementFacts(state) {
  if (state.retiredResources !== undefined && (!Array.isArray(state.retiredResources) || state.retiredResources.some(fact =>
    !fact || typeof fact.key !== 'string' || typeof fact.ownerId !== 'string' || typeof fact.lease !== 'string'
    || JSON.stringify([fact.ownerId, fact.lease]) !== fact.key || !Array.isArray(fact.pageIds) || !Array.isArray(fact.tabIds)
    || [...fact.pageIds, ...fact.tabIds].some(id => typeof id !== 'string')))) throw Error('Invalid browser retirement facts');
  state.retiredResources ??= [];
  const index = new Map(state.retiredResources.map(fact => [fact.key, fact]));
  for (const receipt of state.closedTabs ?? []) recordRetirementFacts(state, receipt, index);
  for (const key of state.retired ?? []) {
    const [ownerId, lease] = JSON.parse(key);
    if (index.has(key)) continue;
    // Older versions compacted receipts. Service-created logical IDs can be
    // recovered from their permanent lease; legacy leases still fence storage.
    const identity = /^browser-([0-9a-f]{64})$/.exec(lease)?.[1];
    recordRetirementFacts(state, { key, ownerId, lease,
      pageIds: identity ? ['page-' + identity] : [], tabIds: identity ? ['tab-' + identity] : [] }, index);
  }
}

export function retirementFacts(state, ownerId) {
  if (state.retiredResources?.lookup) return state.retiredResources.lookup(ownerId);
  // Projection reads never mutate the durable state outside its writer queue.
  const facts = new Map();
  for (const fact of [...(state.retiredResources ?? []), ...(state.closedTabs ?? [])]) {
    if (fact.ownerId !== ownerId) continue;
    const previous = facts.get(fact.key);
    facts.set(fact.key, { lease: fact.lease, pageIds: [...new Set([...(previous?.pageIds ?? []), ...fact.pageIds])],
      tabIds: [...new Set([...(previous?.tabIds ?? []), ...fact.tabIds])] });
  }
  for (const key of state.retired ?? []) {
    const [owner, lease] = JSON.parse(key);
    if (owner !== ownerId || facts.has(key)) continue;
    const identity = /^browser-([0-9a-f]{64})$/.exec(lease)?.[1];
    facts.set(key, { lease, pageIds: identity ? ['page-' + identity] : [], tabIds: identity ? ['tab-' + identity] : [] });
  }
  return [...facts.values()];
}

// State objects are immutable after publication by the writer queue. Cache only
// projections; never put synchronization cursors in durable operation history.
const snapshots = new WeakMap();
export function retirementSnapshot(state, ownerId, scope, cursor) {
  const identity = state;
  let owners = snapshots.get(identity);
  if (!owners) { owners = new Map(); snapshots.set(identity, owners); }
  let snapshot = owners.get(ownerId);
  if (!snapshot) {
    const facts = retirementFacts(state, ownerId), hashes = [scope];
    for (const fact of facts) hashes.push(createHash('sha256').update(hashes.at(-1)).update(JSON.stringify(fact)).digest('hex'));
    snapshot = { facts, hashes }; owners.set(ownerId, snapshot);
  }
  const { facts, hashes } = snapshot;
  const append = cursor && cursor.scope === scope && Number.isSafeInteger(cursor.count)
    && cursor.count >= 0 && cursor.count <= facts.length && hashes[cursor.count] === cursor.digest;
  return { facts, retiredTabs: append ? facts.slice(cursor.count) : facts,
    retiredTabsMode: append ? 'append' : 'replace',
    retirementCursor: { scope, count: facts.length, digest: hashes.at(-1) } };
}
