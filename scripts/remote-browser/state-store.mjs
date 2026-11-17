import { Worker } from 'node:worker_threads';
import { browserMetadataReferences } from '@opencraft/browser-core/metadata-merge';
import { mergeReferences, retirementSelection } from './retirement-selection.mjs';
import { AccountDirectory } from './account-directory.mjs';
import { RetirementIndex } from './retirement-index.mjs';

const tables = { pages: 'key', states: null, closedTabs: 'key' };
function rows(state, field) {
  return new Map((state[field] ?? []).map(row => field === 'states' ? [row[0], JSON.stringify(row[1])] : [row[tables[field]], JSON.stringify(row)]));
}
/** Authorization and domain reducers stay on the service queue. Only row deltas
 * cross the Worker boundary; SQLite owns atomic publication and disk durability. */
export class BrowserStateStore {
  sequence = 0; pending = new Map(); tail = Promise.resolve();
  constructor(directory, onFailure) {
    this.worker = new Worker(new URL('./browser-state-worker.mjs', import.meta.url), { workerData: { directory } });
    const fail = error => {
      if (this.failure || this.closed) return;
      this.failure = Object.assign(error, { code: 'BROWSER_UNAVAILABLE', retryable: false, outcome: 'unknown' });
      for (const waiter of this.pending.values()) waiter.reject(this.failure);
      this.pending.clear(); onFailure?.(this.failure);
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => { if (!this.closed) fail(Error('Browser storage worker exited')); });
    this.worker.on('message', ({ id, value, error }) => {
      const waiter = this.pending.get(id); if (!waiter) return;
      this.pending.delete(id);
      if (error) { const failure = Object.assign(Error(error.message), error); waiter.reject(failure); if (error.fatal) fail(failure); }
      else waiter.resolve(value);
    });
  }
  call(op, args = {}) {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? Error('Browser storage closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, op, args }); } catch (error) { this.pending.delete(id); reject(error); } });
  }
  async open() {
    const { state: saved, outcome } = await this.call('open');
    this.outcome = outcome;
    this.index = new RetirementIndex([]);
    const selection = retirementSelection({ pages: saved.pages, closedTabs: saved.closedTabs });
    this.index.reset(await this.call('select', selection));
    this.selectionSignature = JSON.stringify(selection);
    this.current = { ...saved, ...this.index.views() };
    this.reindexAccounts();
    return this.current;
  }
  enqueue(action) {
    if (this.sealed || this.failure) return Promise.reject(this.failure ?? Error('Browser storage closing'));
    const operation = this.tail.then(action); this.tail = operation.catch(() => {}); return operation;
  }
  reindexAccounts() {
    const accounts = new Map();
    const account = owner => {
      if (!accounts.has(owner)) accounts.set(owner, { pages: [], states: [], closedTabs: [] });
      return accounts.get(owner);
    };
    for (const row of this.current.pages) account(row.ownerId).pages.push(row);
    for (const row of this.current.states) account(row[0]).states.push(row);
    for (const row of this.current.closedTabs) account(row.ownerId).closedTabs.push(row);
    this.accounts = new AccountDirectory();
    for (const [owner, value] of accounts) this.accounts = this.accounts.set(owner, value);
  }
  account(ownerId) {
    return this.accounts.get(ownerId) ?? { pages: [], states: [], closedTabs: [] };
  }
  async preload(options, source = this.current) {
    const selection = retirementSelection(source, options), signature = JSON.stringify(selection);
    if (signature === this.selectionSignature) return;
    this.index.reset(await this.call('select', selection)); this.selectionSignature = signature;
  }
  hasRetirement(key) {
    return this.enqueue(() => this.call('has', { key }));
  }
  readRetirements(owner, references) {
    return this.enqueue(async () => {
      const state = this.account(owner).states[0]?.[1] ?? { revision: 0, values: {} };
      const query = references === undefined ? undefined : mergeReferences(references, ...Object.entries(state.values)
        .filter(([key]) => key !== 'bindings').map(([key, value]) => browserMetadataReferences(key, value)));
      return { ...await this.call('retirements', { owner, references: query }), state };
    });
  }
  // Checkpoints and native inventory may update existing resource rows only.
  // They neither read metadata/receipts nor acquire retirement archive facts.
  transactResources(reduce, options) {
    const keys = Array.isArray(options?.resourceKeys) ? [...options.resourceKeys] : options?.resourceKeys;
    return this.enqueue(async () => {
      if (this.failure) throw this.failure;
      if (keys !== undefined && (!Array.isArray(keys) || keys.some(key => typeof key !== "string")))
        throw Error("Invalid browser resource selection");
      const selected = keys === undefined ? this.current.pages : [...new Set(keys)].map(key => this.accounts.page(key)).filter(Boolean);
      const before = new Map(selected.map(page => [page.key, page]));
      const draft = { pages: structuredClone([...before.values()]) };
      Object.defineProperty(draft, 'capacityUsed', { value: this.accounts.used, enumerable: false });
      const result = reduce(draft);
      if (result && typeof result.then === 'function') throw Error('Browser state reducer must be synchronous');
      if (Object.keys(draft).some(key => key !== 'pages') || !Array.isArray(draft.pages)
        || draft.pages.length !== before.size) throw Error('Browser resource transaction may only update existing resources');
      const seen = new Set(), updated = new Map(), owners = new Set();
      const identity = page => Object.fromEntries(Object.entries(page).filter(([key]) => !['runtime', 'url', 'viewport', 'zoom'].includes(key)));
      for (const page of draft.pages) {
        const previous = before.get(page?.key);
        if (!previous || seen.has(page.key) || JSON.stringify(identity(page)) !== JSON.stringify(identity(previous)))
          throw Error('Browser resource transaction cannot change resource identity or lifecycle');
        seen.add(page.key);
        const encoded = JSON.stringify(page);
        if (encoded !== JSON.stringify(previous)) { updated.set(page.key, [JSON.parse(encoded), encoded]); owners.add(page.ownerId); }
      }
      if (!updated.size) return result;
      await this.call('commit', { changes: { pages: { remove: [], put: [...updated].map(([key, [, encoded]]) => [key, encoded]) },
        states: { remove: [], put: [] }, closedTabs: { remove: [], put: [] } }, facts: [] });
      // Publish after acknowledgement; retain unchanged account payloads and old
      // snapshots. A failed/unknown commit never leaks the detached resource draft.
      for (const ownerId of owners) {
        const account = this.account(ownerId);
        this.accounts = this.accounts.set(ownerId, { ...account,
          pages: account.pages.map(page => updated.get(page.key)?.[0] ?? page) });
      }
      this.current = this.accounts.projection({ schemaVersion: this.current.schemaVersion,
        retired: this.current.retired, retiredResources: this.current.retiredResources });
      return result;
    });
  }
  transact(reduce, options) {
    if (options?.resourcesOnly) return this.transactResources(reduce, options);
    if (this.sealed || this.failure) return Promise.reject(this.failure ?? Error('Browser storage closing'));
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      const ownerId = options?.ownerId;
      const source = ownerId === undefined ? this.current : this.account(ownerId);
      await this.preload(options, source);
      const { retired: _, retiredResources: __, ...small } = source;
      const draft = structuredClone(small), history = this.index.draft();
      draft.retired = history.retired; draft.retiredResources = history.retiredResources;
      Object.defineProperty(draft, 'capacityUsed', { value: this.accounts.used, enumerable: false });
      const result = reduce(draft);
      if (result && typeof result.then === 'function') throw Error('Browser state reducer must be synchronous');
      if (draft.retired !== history.retired || draft.retiredResources !== history.retiredResources) throw Error('Permanent retirement facts cannot be replaced');
      if (ownerId !== undefined && (draft.states.some(([owner]) => owner !== ownerId)
        || draft.pages.some(row => row.ownerId !== ownerId) || draft.closedTabs.some(row => row.ownerId !== ownerId)))
        throw Error('Browser account transaction crossed owner scope');
      const changes = {};
      for (const field of Object.keys(tables)) {
        const before = rows(source, field), after = rows(draft, field);
        changes[field] = { remove: [...before.keys()].filter(key => !after.has(key)),
          put: [...after].filter(([key, value]) => value !== before.get(key)) };
      }
      // Publish the exact encoded rows sent to SQLite, not reducer-owned objects
      // which may still be referenced by a live page or retained by the caller.
      const published = {};
      for (const field of Object.keys(tables)) {
        const previous = new Map(source[field].map(row => [field === 'states' ? row[0] : row.key, row]));
        const changed = new Map(changes[field].put);
        published[field] = draft[field].map(row => {
          const key = field === 'states' ? row[0] : row.key;
          return changed.has(key) ? field === 'states' ? [key, JSON.parse(changed.get(key))] : JSON.parse(changed.get(key)) : previous.get(key);
        });
      }
      const facts = structuredClone(history.finish());
      if (facts.length || Object.values(changes).some(change => change.put.length || change.remove.length))
        await this.call('commit', { changes, facts });
      this.index.apply(facts);
      const views = facts.length ? this.index.views() : { retired: this.current.retired, retiredResources: this.current.retiredResources };
      if (ownerId === undefined) { this.current = { schemaVersion: this.current.schemaVersion, ...published, ...views }; this.reindexAccounts(); }
      else {
        this.accounts = this.accounts.set(ownerId, Object.fromEntries(Object.keys(tables).map(field => [field,
          changes[field].remove.length || changes[field].put.length ? published[field] : source[field]])));
        this.current = this.accounts.projection({ schemaVersion: this.current.schemaVersion, ...views });
      }
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  close() {
    if (this.closing) return this.closing;
    this.sealed = true;
    return this.closing = (async () => {
      try { await this.tail; if (!this.failure) await this.call('close'); }
      finally { this.closed = true; await this.worker.terminate(); }
    })();
  }
}
