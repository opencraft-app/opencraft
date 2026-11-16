/** Minimal resource identities are permanent. Bounded operation receipts do
 * not own the lifetime of metadata anti-resurrection facts. */
export function recordRetirementFacts(state, { key, ownerId, lease, pageIds = [], tabIds = [] }) {
  state.retiredResources ??= [];
  let fact = state.retiredResources.find(entry => entry.key === key);
  if (!fact) { fact = { key, ownerId, lease, pageIds: [], tabIds: [] }; state.retiredResources.push(fact); }
  fact.pageIds = [...new Set([...fact.pageIds, ...pageIds])];
  fact.tabIds = [...new Set([...fact.tabIds, ...tabIds])];
}

export function initializeRetirementFacts(state) {
  if (state.retiredResources !== undefined && (!Array.isArray(state.retiredResources) || state.retiredResources.some(fact =>
    !fact || typeof fact.key !== 'string' || typeof fact.ownerId !== 'string' || typeof fact.lease !== 'string'
    || JSON.stringify([fact.ownerId, fact.lease]) !== fact.key || !Array.isArray(fact.pageIds) || !Array.isArray(fact.tabIds)
    || [...fact.pageIds, ...fact.tabIds].some(id => typeof id !== 'string')))) throw Error('Invalid browser retirement facts');
  state.retiredResources ??= [];
  for (const receipt of state.closedTabs ?? []) recordRetirementFacts(state, receipt);
  for (const key of state.retired ?? []) {
    const [ownerId, lease] = JSON.parse(key);
    if (state.retiredResources.some(fact => fact.key === key)) continue;
    // Older versions compacted receipts. Service-created logical IDs can be
    // recovered from their permanent lease; legacy leases still fence storage.
    const identity = /^browser-([0-9a-f]{64})$/.exec(lease)?.[1];
    recordRetirementFacts(state, { key, ownerId, lease,
      pageIds: identity ? ['page-' + identity] : [], tabIds: identity ? ['tab-' + identity] : [] });
  }
}

export function retirementFacts(state, ownerId) {
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
