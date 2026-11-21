import { referenceLookup } from './retirement-selection.mjs';
/** Query-scoped exact facts and absence proofs. The durable archive lives only
 * in SQLite; unknown keys must be prefetched, never treated as unretired. Drafts
 * copy touched facts and publish new fences after the commit acknowledgement. */
export function leaseFact(key) {
  const [ownerId, lease] = JSON.parse(key);
  const identity = /^browser-([0-9a-f]{64})$/.exec(lease)?.[1];
  return { key, ownerId, lease, pageIds: identity ? ['page-' + identity] : [], tabIds: identity ? ['tab-' + identity] : [] };
}
export class RetirementIndex {
  facts = new Map(); known = new Set(); lookups = new Map();
  constructor(facts) { this.apply(facts); }
  reset({ facts, keys, owners }) {
    this.facts.clear(); this.known = new Set(keys); this.lookups = new Map(owners.map(([owner, refs]) => [owner, referenceLookup(refs)]));
    this.apply(facts);
  }
  includes(key) {
    if (this.facts.has(key)) return true;
    if (!this.known.has(key)) throw Error('Retirement identity was not prefetched');
    return false;
  }
  lookup(owner) { return this.lookups.get(owner) ?? referenceLookup(); }
  apply(facts) {
    for (const fact of facts) {
      Object.freeze(fact.pageIds); Object.freeze(fact.tabIds); Object.freeze(fact);
      this.known.add(fact.key); this.facts.set(fact.key, fact);
      let lookup = this.lookups.get(fact.ownerId);
      if (!lookup) { lookup = referenceLookup(); this.lookups.set(fact.ownerId, lookup); }
      lookup.empty = false; lookup.leases.add(fact.lease); for (const id of fact.pageIds) lookup.pages.add(id); for (const id of fact.tabIds) lookup.tabs.add(id);
    }
  }
  views() {
    const index = this;
    return {
      retired: {
        includes: key => index.includes(key), has: key => index.includes(key),
        get length() { return index.facts.size; }, get size() { return index.facts.size; },
        *[Symbol.iterator]() { yield* index.facts.keys(); }, toJSON() { return [...this]; },
      },
      retiredResources: {
        get: key => { index.includes(key); return index.facts.get(key); },
        lookup: owner => index.lookup(owner),
        get length() { return index.facts.size; },
        *[Symbol.iterator]() { yield* index.facts.values(); },
        find(predicate) { return [...this].find(predicate); }, some(predicate) { return [...this].some(predicate); },
        toJSON() { return [...this]; },
      },
    };
  }
  draft() {
    const index = this, additions = new Set(), changes = new Map();
    const retired = {
      includes: key => additions.has(key) || index.includes(key),
      push(...keys) { for (const key of keys) if (!index.facts.has(key)) additions.add(key); },
    };
    const retiredResources = {
      lookup(owner) {
        const base = index.lookup(owner);
        const has = (kind, id) => base[kind].has(id) || [...changes.values()].some(fact => fact.ownerId === owner &&
          (kind === 'leases' ? fact.lease === id : (kind === 'pages' ? fact.pageIds : fact.tabIds).includes(id)))
          || kind === 'leases' && additions.has(JSON.stringify([owner, id]));
        return { empty: base.empty && ![...changes.values()].some(fact => fact.ownerId === owner)
          && ![...additions].some(key => JSON.parse(key)[0] === owner),
          ...Object.fromEntries(['pages', 'tabs', 'leases'].map(kind => [kind, { has: id => has(kind, id) }])) };
      },
      get(key) {
        if (!changes.has(key)) index.includes(key);
        if (!changes.has(key) && index.facts.has(key)) changes.set(key, structuredClone(index.facts.get(key)));
        return changes.get(key);
      },
      push(fact) { changes.set(fact.key, fact); },
    };
    return { retired, retiredResources, finish() {
      for (const key of additions) if (!changes.has(key)) changes.set(key, leaseFact(key));
      return [...changes.values()].filter(fact => {
        const previous = index.facts.get(fact.key);
        if (previous && (previous.pageIds.some(id => !fact.pageIds.includes(id)) || previous.tabIds.some(id => !fact.tabIds.includes(id))))
          throw Error('Permanent retirement identities cannot be removed');
        return JSON.stringify(fact) !== JSON.stringify(previous);
      });
    } };
  }
}
