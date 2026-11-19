import { parseResourceDirectorySignals } from '@opencraft/workbench-runtime/resource-directory-signals';
import { readPresentation } from '@opencraft/browser-core/presentation';
import { parseSideChatDirectory, serializeSideChatDirectoryV1, validateSideChatDirectoryTransition } from '@opencraft/workbench-runtime/side-chat-records';
import { browserMetadataValueLimit, browserMetadataWireLimit } from '@opencraft/browser-core/metadata-limits';
import { BROWSER_METADATA_FIELDS, PUSH_INLINE_LIMIT, metadataLeaves, metadataRoot } from '@opencraft/browser-core/metadata-sync';
import { mergeBrowserMetadata, retireBrowserMetadata, mergeMetadataValue } from '@opencraft/browser-core/metadata-merge';
import { prepareBrowserRuntimeAccess } from './remote-browser-access.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import nativeDiagnostics from './remote-browser/diagnostics.cjs';
import displayFlow from './remote-browser/display.cjs';
import mediaPolicy from '@opencraft/remote-interaction/policy';
import { acquireBrowserStateWriter, sessionError, sessionLink, sessionLinkIndex, linkedSessions, occupied, conversationScopes, browserConversation, conversationResourceLinks } from './remote-browser-state-file.mjs';
import { BrowserStateStore } from './remote-browser/state-store.mjs';
import { startBrowserOwner } from './remote-browser-owner.mjs';
import { invokeRemoteAutomation } from './remote-browser/automation-service.mjs';
import { activateRemotePage, acquirePageActivation } from './remote-browser/page-lifecycle.mjs';
import { bindBrowserInvocation, invokeWithReceipt } from './remote-browser/operation-receipts.mjs';
import { presentRemoteTab, acknowledgePresentation } from './remote-browser/tab-presentation.mjs';
import { createRemoteTab } from './remote-browser/tab-creation.mjs';
import { retireRemotePage, commitRemoteRetirement } from './remote-browser/tab-retirement.mjs';
import { closeRemoteTab } from './remote-browser/tab-close.mjs';
import { referenceLookup, referenceFacts, validateReferences } from './remote-browser/retirement-selection.mjs';
import { retirementFacts, retirementSnapshot } from './remote-browser/retirement-facts.mjs';

const methods = new Set(['viewport', 'navigate', 'reload', 'stop', 'back', 'forward', 'visible', 'keyframe', 'capture', 'annotation-overlay', 'zoom', 'input', 'text', 'ime', 'copy', 'automation', 'close']);
const quietMethods = new Set(['visible', 'keyframe', 'input', 'text']);
const unavailable = (message) => Object.assign(new Error(message), { code: 'BROWSER_UNAVAILABLE', retryable: true });
const interruptedRequest = (request, message) => Object.assign(unavailable(message),
  request.method === 'automation' ? { retryable: false, outcome: 'unknown' } : {});
// The worker's bootstrap document is an empty tab, not an external URL.
const checkpointUrl = (url) => (url === "about:blank" || url === "" ? null : url);
function removedStorageLeases(previous, next) {
  const parse = (value) => {
    if (typeof value !== 'string') return null;
    try {
      const entries = JSON.parse(value);
      if (!entries || Array.isArray(entries) || typeof entries !== 'object') return null;
      const leases = Object.values(entries);
      if (leases.some((lease) => typeof lease !== 'string' || !/^browser[:-][a-zA-Z0-9-]+$/.test(lease))) return null;
      return new Set(leases.map((lease) => lease.replace(':', '-')));
    } catch { return null; }
  };
  const before = parse(previous), after = parse(next);
  return before && after ? [...before].filter((lease) => !after.has(lease)) : [];
}
/** Gateway-authorized page leases, with an independent managed Linux owner.
 * A client gets only its own page port,
 * never a CDP endpoint, filesystem path or arbitrary JavaScript evaluator. */
export class RemoteBrowserService {
  constructor({ root, dataDirectory, executable, allowNoSandbox = false, spawnImpl = spawn, mediaBuckets, conversationLifecycle,
    ownerAvailable,
    ownerConnector = process.platform === 'linux' && process.getuid?.() === 0 && !allowNoSandbox && spawnImpl === spawn ? startBrowserOwner : null }) {
    this.conversationLifecycle = conversationLifecycle;
    this.directory = join(root, 'runtime/browser');
    this.executable = executable ?? join(this.directory, 'electron/electron');
    this.dataDirectory = join(dataDirectory, 'remote-browser');
    this.allowNoSandbox = allowNoSandbox;
    this.spawnImpl = spawnImpl;
    if (ownerAvailable !== undefined && (typeof ownerAvailable !== "function" || typeof ownerConnector !== "function"))
      throw new Error("Owner readiness requires a private browser owner connector");
    this.ownerConnector = ownerConnector;
    this.ownerAvailable = ownerAvailable;
    this.pages = new Map(); this.requests = new Map(); this.sockets = new Set();
    this.attachments = new Map(); this.presentationObservers = new Map(); this.metadataObservers = new Map(); this.metadataHashes = new Map();
    this.metadataPeers = new Map();
    this.states = new Map(); this.persistence = Promise.resolve();
    this.mediaBuckets = mediaPolicy.bucketBounds(mediaBuckets);
    this.diagnosticCount = 0;
    this.diagnosticCounts = new Map();
    this.display = displayFlow.createDisplayFlow({ bounds: this.mediaBuckets, keyframe: (page, bucket) => this.keyframe(page, bucket), diagnose: (event) => this.diagnose(event),
      pace: (page) => this.displayPace(page) });
    this.server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: browserMetadataWireLimit });
  }
  async load() {
    if (this.closed) throw new Error('Browser service closed');
      this.loading ??= (async () => {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
      if (this.closed) throw new Error('Browser service closed');
      this.releaseWriter = await acquireBrowserStateWriter(this.dataDirectory);
      if (this.closed) throw new Error('Browser service closed');
      this.store = new BrowserStateStore(this.dataDirectory, () => { if (this.loaded) this.close(); });
      await this.store.open();
      if (this.closed) throw new Error('Browser service closed');
      await this.store.transact(
        (draft) => {
        if (this.closed) throw new Error('Browser service closed');
        for (const p of draft.pages) if (p.runtime?.kind !== 'absent') p.runtime = { ...p.runtime, kind: this.ownerConnector ? 'unknown' : 'absent' };
      }, { resourcesOnly: true });
      const saved = this.store.current;
      for (const p of saved.pages) {
        this.pages.set(p.key, { ...structuredClone(p), url: checkpointUrl(p.url), controller: null, live: false });
      }
      for (const [owner, state] of saved.states) this.states.set(owner, state);
      this.loaded = true;
      for (const page of this.pages.values()) if (page.closing) this.retryRetirement(page, 0);
    })().catch(async (error) => {
      // Cleanup belongs to this shared loading attempt, not each awaiting caller.
      await this.store?.close().catch(() => {});
      await this.releaseWriter?.(); this.releaseWriter = null;
      if (error.code === 'BROWSER_UNAVAILABLE' && error.retryable === true) this.loading = null;
      throw error;
    });
    return this.loading;
  }

  storageOutcomes() {
    const outcome = this.loaded && !this.closed && this.store?.outcome;
    return outcome ? [{ name: 'remote-browser', status: outcome.status, appliedVersion: outcome.appliedVersion,
      backupPath: outcome.backupPath, movedAside: outcome.movedAsidePaths.length > 0 }] : [];
  }
  commit(reduce, selection) {
    if (this.closed) return Promise.reject(new Error('Browser service closed'));
    const operation = this.store.transact(reduce, selection);
    this.persistence = this.store.tail;
    return operation;
  }
  persist(keys) {
    // Checkpoints may update recovery configuration of committed sessions only.
    // In-flight native state is never inferred from the mutable viewer Map.
    const pages = keys === undefined ? [...this.pages.values()] : [...new Set(keys)].map((key) => this.pages.get(key)).filter(Boolean);
    const checkpoints = pages.map(({ key, url, viewport, zoom }) => ({ key, url, viewport, zoom }));
    return this.commit(
      (draft) => {
      const records = new Map(draft.pages.map((record) => [record.key, record]));
      for (const value of checkpoints) {
        const record = records.get(value.key);
        if (record && record.lifecycle !== 'closed') Object.assign(record, value);
      }
    }, { resourcesOnly: true, resourceKeys: checkpoints.map((page) => page.key) });
  }
  async presentation(ownerId, input, authorize) {
    if (!/^[a-zA-Z0-9-]{20,128}$/.test(input?.lease ?? '')) throw new Error('Invalid browser lease');
    await this.load(); authorize();
    const key = JSON.stringify([ownerId, input.lease]), page = this.pages.get(key);
    if (!page || page.closing || (await this.store.hasRetirement(key))) return null;
    // Attach to the owner inventory; never create/resume a physical page or viewer.
    await this.start(); authorize();
    if (!page.live || this.pages.get(key) !== page || page.closing) return null;
    const capabilities = await this.request(page.id, 'snapshot'); authorize();
    if (capabilities.presentationVersion !== 1) return null;
    const value = readPresentation(await this.request(page.id, 'presentation'));
    authorize();
    if (this.pages.get(key) !== page || page.closing || (value && page.document && value.document !== page.document)) return null;
    return value?.revision === input.revision ? { version: 1, unchanged: true, revision: value.revision } : value;
  }
  async catalog(ownerId, authorize) {
    await this.load(); await this.store.tail; authorize();
    return { sessions: this.store.account(ownerId).pages.filter((p) => p.lifecycle !== "closed")
        .map((p) => ({
      sessionId: p.id, lease: JSON.parse(p.key)[1], lifecycle: p.lifecycle,
      runtime: p.runtime?.kind ?? 'unknown', link: p.link ?? null, url: p.url,
      createdAt: p.createdAt ?? null,
    })), capacity: { limit: 64, used: this.store.accounts.used, accountLimit: 16,
      accountUsed: this.store.account(ownerId).pages.filter(occupied).length } };
  }
  acquirePageActivation(key) { return acquirePageActivation(this, key); }
  activatePage(options) { return activateRemotePage(this, options); }
  bindInvocation(binding, tool, input, options) { return bindBrowserInvocation(this, binding, tool, input, options); }
  createTab(binding, input, options) { return createRemoteTab(this, binding, input, options); }
  presentationAvailable(ownerId) {
    return [...this.metadataPeers].some(([socket, peer]) => {
      try { peer.authorize(); return peer.ownerId === ownerId && socket.readyState === WebSocket.OPEN; } catch { return false; }
    });
  }
  presentTab(binding, input, options) { return presentRemoteTab(this, binding, input, options); }
  closeTab(binding, input, options) { return closeRemoteTab(this, binding, input, options); }
  metadataChanged(ownerId, change) {
    if (change) { this.publishMetadata(ownerId, change.origin, change.key, change.value, change.keyRevision, change.revision, change.sideChatDirectory); return; }
    const state = this.store.account(ownerId).states[0]?.[1];
    const peers = new Map([...this.metadataPeers, ...this.metadataObservers]);
    for (const [ws, peer] of peers) {
      if (peer.ownerId !== ownerId || ws.readyState !== WebSocket.OPEN) continue;
      try { peer.authorize(); ws.send(JSON.stringify({ type: 'metadata-changed', scope: this.metadataScope(ownerId), revision: state?.revision ?? 0 })); }
      catch { ws.close(1008, 'Browser authorization expired'); }
    }
  }
  async conversationTabs(ownerId, hostId, threadId, authorize) {
    await this.load(); await this.store.tail; authorize();
    if (this.closed) throw unavailable('Browser service closed');
    const state = this.store.account(ownerId).states[0]?.[1];
    const scopes = conversationScopes(state, hostId, threadId);
    return linkedSessions(ownerId, state).flatMap((entry) => {
      const record = this.store.account(ownerId).pages.find((page) => page.key === entry.key);
      if (!record || record.lifecycle !== 'open' || entry.link.hostId !== hostId || !scopes.has(entry.link.scopeId)) return [];
      return [{ tabId: entry.link.tabId, pageId: entry.link.pageId, lease: JSON.parse(entry.key)[1], scopeId: entry.link.scopeId,
        url: record.url, runtime: record.runtime?.kind ?? 'unknown' }];
    });
  }
  assertConversation(ownerId, key) {
    const state = this.states.get(ownerId);
    const record = this.store?.accounts.page(key);
    const conversation = browserConversation(state, sessionLink(state, JSON.parse(key)[1]) ?? record?.link);
    if (conversation) this.conversationLifecycle?.assertActive(conversation.hostId, conversation.threadId);
  }
  async threadAliases(hostId, threadId) {
    await this.load();
    return [...this.states].flatMap(([actorId, state]) => {
      try { return JSON.parse(state.values.bindings ?? '[]')
        .filter((b) => b.hostId === hostId && b.threadId === threadId && typeof b.scopeId === 'string')
        .map((b) => ({actorId, resourceOwnerId:b.scopeId})); }
      catch { return []; }
    });
  }
  async threadScopes() {
    await this.load();
    const scopes = this.store.current.pages.flatMap((record) => {
      const state = this.states.get(record.ownerId);
      const owner = browserConversation(state, sessionLink(state, JSON.parse(record.key)[1]) ?? record.link);
      return owner ? [owner] : [];
    });
    for (const state of this.states.values()) {
      try { for (const b of JSON.parse(state.values.bindings ?? '[]'))
        if (typeof b.hostId === 'string' && typeof b.threadId === 'string' && b.threadId) scopes.push({hostId:b.hostId,threadId:b.threadId}); } catch {}
    }
    return scopes;
  }
  async releaseThread(hostId, threadId) {
    await this.load();
    const matches = [...this.pages.values()].filter((page) => {
      const state = this.states.get(page.ownerId), record = this.store.current.pages.find((p) => p.key === page.key);
      const owner = browserConversation(state, sessionLink(state, JSON.parse(page.key)[1]) ?? record?.link);
      return owner?.hostId === hostId && owner.threadId === threadId;
    });
    await Promise.all(matches.map((page) => this.suspendPage(page)));
  }
  async suspendPage(page) {
    if (page.retirement) return page.retirement; // Explicit tab deletion wins.
    if (page.suspension) return page.suspension;
    page.closing = true; this.resetVisibility(page);
    page.suspension = (async () => {
      await this.runtimeState(page, 'stopping');
      for (const ws of this.viewers(page).keys()) ws.close(1000, 'Conversation archived');
      if (page.creating) await page.creating.catch(() => {});
      await this.start();
      await this.request(page.id, 'close');
      page.live = false; page.controller = null; this.viewers(page).clear();
      await this.runtimeState(page, 'absent');
      // Keep URL/zoom and logical tab. Unarchive may create a fresh native page.
      page.closing = false;
    })().finally(() => { page.suspension = null; });
    return page.suspension;
  }
  async reserve(ownerId, key, input, authorize) {
    return this.commit(
      (draft) => {
      authorize(); this.assertConversation(ownerId, key);
      if (draft.retired.includes(key)) throw sessionError('SESSION_CLOSED', 'Browser tab is closed');
      let record = draft.pages.find((p) => p.key === key);
      const state = draft.states.find(([owner]) => owner === ownerId)?.[1];
      const link = sessionLink(state, JSON.parse(key)[1]);
      if (input.metadataRequired && !link) throw sessionError('STATE_CONFLICT', 'Browser tab metadata has not been committed; reload to synchronize');
      if (record?.lifecycle === 'closing') throw sessionError('SESSION_CLOSING', 'Browser tab is closing');
      const page = this.pages.get(key);
      if (record?.runtime?.kind === 'unknown' && !page?.live)
        throw sessionError('RUNTIME_UNKNOWN', 'Browser page outcome is being reconciled; reconnect to check again', true);
      if (!record || !occupied(record)) {
        const used = draft.pages.filter(occupied);
        if (used.filter((p) => p.ownerId === ownerId).length >= 16)
          throw sessionError('ACCOUNT_CAPACITY', 'Your active browser page limit (16) is reached; close a page in Browser resources');
        if (draft.capacityUsed >= 64)
          throw sessionError('RUNTIME_CAPACITY', 'Shared browser capacity (64) is full; use Browser resources to manage your pages', true);
      }
      if (!record) {
        if (draft.pages.filter((p) => p.ownerId === ownerId).length >= 256) throw sessionError('SESSION_CAPACITY', 'Your saved browser session limit (256) is reached; close a session in Browser resources');
        record = { id: createHash('sha256').update(key).digest('hex'), key, ownerId, lifecycle: 'open',
          createdAt: Date.now(), version: 0, url: checkpointUrl(input.initialUrl ?? null), zoom: 100, viewport: input.viewport, runtime: { kind: 'absent', generation: 0 } };
        draft.pages.push(record);
      }
      if (link) record.link = link;
      if (!page?.live) {
        const generation = (record.runtime?.generation ?? 0) + 1;
        record.runtime = { kind: 'starting', generation, operationId: randomUUID() };
      }
      record.version = (record.version ?? 0) + 1;
      return structuredClone(record);
    }, { ownerId, keys: [key] });
  }
  async runtimeState(page, kind, epoch = page.runtimeEpoch ?? 0) {
    return this.commit(
      (draft) => {
        const record = draft.pages.find((p) => p.key === page.key);
      if (!record || (page.runtimeEpoch ?? 0) !== epoch) return;
      // A close intent wins over every late create/config ACK.
      if (record.lifecycle !== 'open' && kind === 'live') return;
      record.runtime = { ...record.runtime, kind };
      if (kind === 'live') { record.url = page.url; record.viewport = page.viewport; record.zoom = page.zoom; }
    }, { ownerId: page.ownerId });
  }
  checkpoint(key) {
    if (this.closed) return;
    (this.checkpointKeys ??= new Set()).add(key);
    if (this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      const keys = [...this.checkpointKeys]; this.checkpointKeys.clear();
      void this.persist(keys).catch(() => {
        for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'error', message: 'Browser recovery state could not be saved' }));
      });
    }, 150);
    this.checkpointTimer.unref();
  }
  metadataHash(text) {
    // Node SHA-256 is byte-identical to the portable client implementation.
    let value = this.metadataHashes.get(text);
    if (value === undefined) {
      value = createHash('sha256').update(text).digest('hex');
      if (this.metadataHashes.size >= 64) this.metadataHashes.delete(this.metadataHashes.keys().next().value);
      this.metadataHashes.set(text, value);
    }
    return value;
  }
  metadataScope(ownerId) { return createHash('sha256').update(this.dataDirectory + '\0' + ownerId).digest('hex'); }
  sideChatDirectoryProjection(state) {
    return { version: 1, keyRevision: state.keyRevisions?.sideChats ?? 0, value: state.sideChatDirectory ?? state.values.sideChats ?? '[]' };
  }
  metadataFingerprint(state, includeSideChats = false) {
    const hash = (text) => this.metadataHash(text), leaves = metadataLeaves(state.values, state.keyRevisions, hash);
    return { metadataDigestVersion: 2, leaves, root: metadataRoot(leaves, hash), ...(includeSideChats ? { sideChatDirectory: this.sideChatDirectoryProjection(state) } : {}) };
  }
  /** Anti-entropy: clients compare a fingerprint root, then read only divergent fields. */
  async metadataDigest(ownerId, input, authorize, references) {
    await this.load(); await this.store.tail; authorize();
    if (input !== undefined && (!input || typeof input !== 'object' || (input.root !== undefined && (typeof input.root !== 'string' || input.root.length > 128))
      || (input.read !== undefined && (!Array.isArray(input.read) || input.read.some((key) => !BROWSER_METADATA_FIELDS.includes(key))))))
      throw new Error('Invalid browser metadata digest');
    if (input?.versions !== undefined && (!input.versions || typeof input.versions !== 'object' || Array.isArray(input.versions)
      || Object.entries(input.versions).some(([field, version]) => !BROWSER_METADATA_FIELDS.includes(field) || !Number.isSafeInteger(version) || version < 0))) throw new Error('Invalid browser metadata versions');
    const selected = await this.store.readRetirements(ownerId, references === undefined ? undefined : validateReferences(references)); authorize();
    const state = selected.state;
    const retirementProjection = references === undefined ? {} : { retirementProjection: 'references', retiredTabsMode: 'replace', retiredTabs: referenceFacts(selected.references) };
    const hash = (text) => this.metadataHash(text);
    const leaves = metadataLeaves(state.values, state.keyRevisions, hash), root = metadataRoot(leaves, hash);
    const read = input?.versions ? BROWSER_METADATA_FIELDS.filter((field) => (state.keyRevisions?.[field] ?? 0) > (input.versions[field] ?? 0)) : input?.read;
    const reply = { metadataDigestVersion: 2, scope: this.metadataScope(ownerId), revision: state.revision, root, leaves, ...retirementProjection,
      presentationRequests: state.presentationRequests ?? [],
      ...(read?.includes('sideChats') ? { sideChatDirectory: this.sideChatDirectoryProjection(state) } : {}) };
    if (input?.root === root && !read?.length) return { ...reply, equal: true };
    return { ...reply, equal: false,
      ...(read?.length ? { values: Object.fromEntries(read.filter((key) => typeof state.values[key] === 'string').map((key) => [key, state.values[key]])) } : {}) };
  }
  publishMetadata(ownerId, origin, key, value, keyRevision, revision, sideChatDirectory) {
    const scope = this.metadataScope(ownerId), hash = this.metadataHash('browser-metadata-leaf-v1:' + key + ':' + value);
    for (const [ws, observer] of this.metadataObservers) {
      if (ws === origin || observer.ownerId !== ownerId || ws.readyState !== WebSocket.OPEN) continue;
      try { observer.authorize(); } catch { ws.close(1008, 'Browser admission expired'); continue; }
      // A congested or oversized push carries only the fingerprint; the client
      // then fetches exactly that one field through the digest.
      if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Browser state backlog; reconnecting'); continue; }
      const payload = { type: 'metadata-changed', scope, revision, key, keyRevision, hash, value,
        ...(sideChatDirectory ? { sideChatDirectory } : {}) };
      const inline = ws.bufferedAmount < 256 * 1024 && JSON.stringify(payload).length <= Math.min(PUSH_INLINE_LIMIT, browserMetadataWireLimit);
      ws.send(JSON.stringify(inline ? payload : { type: 'metadata-changed', scope, revision, key, keyRevision, hash }));
    }
  }
  async metadata(ownerId, input, authorize, cursor, references, origin = null) {
    if (cursor && typeof cursor.send === 'function') { origin = cursor; cursor = undefined; }
    await this.load();
    if (input === undefined) {
      await this.store.tail; authorize();
      const scope = createHash('sha256').update(this.dataDirectory + '\0' + ownerId).digest('hex');
      const query = references === undefined ? undefined : validateReferences(references);
      const selected = await this.store.readRetirements(ownerId, query); authorize();
      if (this.closed) throw new Error('Browser service closed');
      const previous = selected.state;
      const retirements = query === undefined ? selected.facts : referenceLookup(selected.references);
      let retirementUpdate;
      if (query === undefined) {
        const { facts: _, ...update } = retirementSnapshot({ retiredResources: selected.facts }, ownerId, scope, cursor);
        retirementUpdate = update;
      } else retirementUpdate = { retiredTabs: referenceFacts(selected.references), retiredTabsMode: 'replace', retirementProjection: 'references' };
      const values = Object.fromEntries(Object.entries(previous.values).map(([key, value]) => [key,
        ['pages', 'tabs', 'storage'].includes(key) ? retireBrowserMetadata(key, value, retirements) : value]));
      return { ...previous, values, ...retirementUpdate, ...this.metadataFingerprint(previous, true), scope };
    }
    const retiring = [], linkedOwners = [];
    let changed = false;
    const reconcile = () => {
      const account = this.store.account(ownerId);
      for (const [owner, state] of account.states) this.states.set(owner, state);
      for (const record of account.pages) if (!this.pages.has(record.key))
        this.pages.set(record.key, { ...structuredClone(record), controller: null, live: false });
      for (const key of retiring) { const page = this.pages.get(key); if (page) { page.closing = true; this.retryRetirement(page, 0); } }
      if (changed) {
        const state = account.states[0]?.[1];
        this.metadataChanged(ownerId, { origin, key: input.key, value: state.values[input.key], keyRevision: state.keyRevisions[input.key], revision: state.revision, sideChatDirectory: input.key === 'sideChats' ? this.sideChatDirectoryProjection(state) : undefined });
      }
    };
    let result;
    try { result = await this.commit(
        (draft) => {
      if (this.closed) throw new Error('Browser service closed');
      authorize();
      const previous = draft.states.find(([owner]) => owner === ownerId)?.[1] ?? { revision: 0, values: {} };
      const scope = createHash('sha256').update(this.dataDirectory + '\0' + ownerId).digest('hex');
      if (input.scope !== scope) throw sessionError('STATE_CONFLICT', 'Browser account changed; reload to synchronize');
      if (!BROWSER_METADATA_FIELDS.includes(input.key) || typeof input.value !== 'string' || input.value.length > browserMetadataValueLimit(input.key)
        || !/^[a-zA-Z0-9-]{20,100}$/.test(input.mutationId ?? '')) throw new Error('Invalid browser metadata');
      if (input.sideChatDirectory !== undefined && (input.key !== 'sideChats' || typeof input.sideChatDirectory !== 'string'
        || input.sideChatDirectory.length > browserMetadataValueLimit('sideChats'))) throw new Error('Invalid side chat binding intent');
      const merging = Object.hasOwn(input, 'baseValue');
      if (merging && ((input.baseValue !== null && (typeof input.baseValue !== 'string' || input.baseValue.length > browserMetadataValueLimit(input.key)))
        || !Number.isSafeInteger(input.expectedKeyRevision) || input.expectedKeyRevision < 0 || input.expectedKeyRevision > (previous.keyRevisions?.[input.key] ?? 0))) throw sessionError('STATE_CONFLICT', 'Invalid browser metadata base');
      const fingerprint = createHash('sha256').update(JSON.stringify(merging ? [input.key, input.value, input.baseValue, input.sideChatDirectory ?? null] : input.sideChatDirectory === undefined ? [input.key, input.value] : [input.key, input.value, input.sideChatDirectory])).digest('hex');
      const receipt = previous.receipts?.find((r) => r.id === input.mutationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw sessionError('OPERATION_CONFLICT', 'Browser operation ID reused with different content');
        return merging ? { revision: previous.revision, keyRevision: previous.keyRevisions?.[input.key] ?? 0, value: previous.values[input.key] }
          : { revision: receipt.revision, keyRevision: receipt.keyRevision, value: previous.values[input.key], ...this.metadataFingerprint(previous, input.key === 'sideChats') };
      }
      if (input.mutationId === previous.lastMutation && !previous.receipts) return { revision: previous.revision };
      if (!merging && (input.expectedKeyRevision !== undefined ? input.expectedKeyRevision !== (previous.keyRevisions?.[input.key] ?? 0) : input.expectedRevision !== previous.revision)) throw sessionError('STATE_CONFLICT', 'Browser state changed in another client; reload to synchronize');
      // A missing receipt is ambiguous after compaction. Old merge bases must
      // not reapply an already committed edit whose ACK was lost.
      const receiptFloor = previous.receiptFloor ?? (previous.receipts?.length === 256 ? previous.receipts[0].revision - 1 : 0);
      if (merging && receiptFloor > 0 && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < receiptFloor))
        throw sessionError('STATE_CONFLICT', 'Browser metadata retry history expired; reload to synchronize');
      const retirements = retirementFacts(draft, ownerId);
      let value = retireBrowserMetadata(input.key, merging ? (['sideChats', 'resourceSignals'].includes(input.key) ? (key, base, local, remote) => mergeMetadataValue(key, base ?? undefined, local ?? undefined, remote ?? undefined) : mergeBrowserMetadata)(input.key,
        retireBrowserMetadata(input.key, input.baseValue, retirements), retireBrowserMetadata(input.key, input.value, retirements),
        retireBrowserMetadata(input.key, previous.values[input.key] ?? null, retirements)) : input.value, retirements);
      if (typeof value !== 'string' || value.length > browserMetadataValueLimit(input.key)) throw sessionError('STATE_TOO_LARGE', 'Browser metadata is too large');
      let sideChatDirectory = previous.sideChatDirectory;
      if (input.key === 'resourceSignals') parseResourceDirectorySignals(JSON.parse(value));
      if (input.key === 'sideChats') {
        const proposed = parseSideChatDirectory(JSON.parse(input.sideChatDirectory ?? input.value));
        if (serializeSideChatDirectoryV1(proposed) !== serializeSideChatDirectoryV1(parseSideChatDirectory(JSON.parse(input.value)))) throw new Error('Side chat binding intent differs from its metadata leaf');
        const canonical = parseSideChatDirectory(JSON.parse(previous.sideChatDirectory ?? previous.values.sideChats ?? '[]'));
        // Check submitted identities even when close-wins merging hides a stale
        // open row. Never let a concurrent tombstone conceal a rebind attempt.
        const submitted = new Map(proposed.map((row) => [row.id, row]));
        validateSideChatDirectoryTransition(canonical, canonical.map((old) => {
          const row = submitted.get(old.id) ?? old;
          return 'closed' in old ? { ...row, closed: true } : row;
        }));
        const merged = merging ? parseSideChatDirectory(JSON.parse(mergeMetadataValue('sideChats', input.baseValue ?? undefined,
          JSON.stringify(proposed), JSON.stringify(canonical)))) : proposed;
        const directory = validateSideChatDirectoryTransition(canonical, merged);
        sideChatDirectory = JSON.stringify(directory);
        if (sideChatDirectory.length > browserMetadataValueLimit('sideChats')) throw sessionError('STATE_TOO_LARGE', 'Side chat directory is too large');
        value = serializeSideChatDirectoryV1(directory);
      }
      const keyRevision = (previous.keyRevisions?.[input.key] ?? 0) + 1;
      const next = { ...previous, revision: previous.revision + 1, keyRevisions: { ...previous.keyRevisions, [input.key]: keyRevision }, lastMutation: input.mutationId,
        ...(sideChatDirectory === undefined ? {} : { sideChatDirectory }),
        values: { ...previous.values, [input.key]: value },
        receiptFloor: Math.max(receiptFloor, (previous.receipts?.length ?? 0) >= 256 ? previous.receipts[0].revision : 0),
        receipts: [...(previous.receipts ?? []), { id: input.mutationId, fingerprint, revision: previous.revision + 1, keyRevision }].slice(-256) };
      const previousLinks = conversationResourceLinks(ownerId, previous);
      for (const [key, owner] of conversationResourceLinks(ownerId, next))
        if (JSON.stringify(previousLinks.get(key)) !== JSON.stringify(owner)) linkedOwners.push(owner);
      // Old receipts can never execute again: their original CAS revision is
      // below the monotonically increasing revision even after compaction.
      draft.states = draft.states.filter(([owner]) => owner !== ownerId); draft.states.push([ownerId, next]);
      const links = sessionLinkIndex(next), existingKeys = new Set(draft.pages.map((record) => record.key));
      for (const record of draft.pages) {
        const link = links.get(JSON.parse(record.key)[1])?.link;
        if (link) record.link = link;
      }
      // Import complete legacy projections into the canonical directory in the
      // same commit as their final dependency. Listing does not reserve native.
      for (const candidate of linkedSessions(ownerId, next, links)) {
        if (draft.retired.includes(candidate.key) || existingKeys.has(candidate.key)) continue;
        if (draft.pages.length >= 256) throw sessionError('SESSION_CAPACITY', 'Your saved browser session limit (256) is reached');
        draft.pages.push({ ...candidate, id: createHash('sha256').update(candidate.key).digest('hex'), ownerId,
          lifecycle: 'open', version: 1, createdAt: Date.now(), zoom: 100, runtime: { kind: 'absent', generation: 0 } });
        existingKeys.add(candidate.key);
      }
      // Compatibility close intent for old clients. Only explicit removal of a
      // previously committed reference counts; missing/malformed maps do not.
      for (const lease of input.key === 'storage' ? removedStorageLeases(previous.values.storage, value) : []) {
        const key = JSON.stringify([ownerId, lease]);
        const record = draft.pages.find((p) => p.key === key);
        if (record) { commitRemoteRetirement(draft, this.pages.get(key) ?? record, { advanceRevision: false }); retiring.push(key); }
        else if (!draft.retired.includes(key)) draft.retired.push(key);
      }
      changed = true;
      return { revision: next.revision, keyRevision, value, ...this.metadataFingerprint(next, input.key === 'sideChats') };
    }, { ownerId, values: ['pages', 'tabs', 'storage'].includes(input?.key) ? [input.value, input.baseValue].filter((value) => typeof value === "string")
                .map((value) => ({ ownerId, key: input.key, value })) : [] }); }
    catch (error) {
      // A reported failure can follow metadata publication.
      // A retained receipt proves this draft's mutation reached committed state.
      const published = changed && this.store.account(ownerId).states[0]?.[1]
        .receipts?.some((receipt) => receipt.id === input.mutationId);
      if (published) {
        reconcile(); Object.assign(error, { retryable: false, outcome: 'unknown' });
      }
      throw error;
    }
    reconcile();
    for (const owner of linkedOwners) this.conversationLifecycle?.resourceLinked(owner.hostId, owner.threadId);
    return result;
  }
  viewers(page) { return (page.viewers ??= new Map()); }
  controlState(page, ws) {
    return { epoch: page.controlEpoch ?? 0, active: !!page.controller, controller: page.controller === ws,
      kind: page.controlKind ?? null, ...(page.controller === ws ? { token: page.controlToken } : {}), viewers: this.viewers(page).size };
  }
  controlChanged(page) {
    for (const [ws, viewer] of this.viewers(page)) if (ws.readyState === WebSocket.OPEN) {
      try { viewer.authorize(); ws.send(JSON.stringify({ type: 'control', ...this.controlState(page, ws) })); } catch { ws.close(1008, 'Browser authorization expired'); }
    }
  }
  controlQueue(page, operation) {
    const next = (page.controlQueue ?? Promise.resolve()).then(operation);
    const tail = next.catch(() => {}); page.controlQueue = tail;
    void tail.then(() => { if (page.controlQueue === tail) page.controlQueue = null; });
    return next;
  }
  control(page, ws, input, authorize) {
    const viewer = this.viewers(page).get(ws), intent = viewer?.visibilityEpoch ?? 0;
    const humanCurrent = () => input?.action !== 'human'
      || (viewer?.visible && (viewer.visibilityEpoch ?? 0) === intent);
    return this.changeControl(page, ws, input, authorize,
      () => this.viewers(page).get(ws) === viewer && !!viewer && ws.readyState === WebSocket.OPEN, humanCurrent);
  }
  changeControl(page, participant, input, authorize, current, humanCurrent = () => true) {
    return this.controlQueue(page, async () => {
      authorize();
      if (page.closing || !current()) throw new Error('Browser controller closed');
      if (!['human', 'agent', 'release'].includes(input?.action)) throw new Error('Invalid browser control request');
      if (!humanCurrent()) throw Object.assign(new Error('Browser interaction ended'), { code: 'CONTROL_LOST', retryable: true });
      const release = input.action === 'release';
      if (release && (page.controller !== participant || input.token !== page.controlToken)) return this.controlState(page, participant);
      if (!release && page.controller === participant && page.controlKind === input.action) return this.controlState(page, participant);
      // Agent work automatically retires human input. Another Agent keeps its
      // admitted operation until completion; do not make concurrent agents fight.
      const agentTakesHuman = input.action === 'agent' && page.controlKind === 'human';
      if (!release && page.controller && !agentTakesHuman && (input.action === 'agent' || input.takeover !== true))
        throw Object.assign(new Error('Browser is controlled by another operation'), { code: 'CONTROL_BUSY', retryable: true });
      const previousToken = page.controlToken;
      page.controller = null; page.controlToken = null; page.controlKind = null;
      for (const request of this.requests.values())
        if (request.page === page.id && request.method === 'automation' && request.control && request.control === previousToken) request.cancel?.();
      const epoch = (page.controlEpoch = (page.controlEpoch ?? 0) + 1);
      this.controlChanged(page);
      const token = release ? null : randomUUID();
      // Ordered with native input/automation: old queued commands are fenced at
      // dispatch, and pressed contacts/keys/composition retire before the grant.
      await this.request(page.id, 'control', { token });
      try {
        authorize();
        if (page.closing || !current() || !humanCurrent())
          throw Object.assign(new Error('Browser interaction ended'), { code: 'CONTROL_LOST', retryable: true });
      } catch (error) { await this.request(page.id, 'control', { token: null }); throw error; }
      if (!release) { page.controller = participant; page.controlToken = token; page.controlKind = input.action; }
      this.controlChanged(page);
      if (!release) void this.request(page.id, 'observe').catch(() => {});
      return { ...this.controlState(page, participant), epoch };
    });
  }
  layoutViewport(page, ws, input, authorize) {
    const viewer = this.viewers(page).get(ws), visibility = viewer?.visibilityEpoch ?? 0;
    return this.controlQueue(page, async () => {
      authorize();
      const current = () => !this.closed && !page.closing && this.pages.get(page.key) === page
        && this.viewers(page).get(ws) === viewer && viewer?.visible && viewer.ready && viewer.modern
        && (viewer.visibilityEpoch ?? 0) === visibility && ws.readyState === WebSocket.OPEN;
      // One visible attachment owns idle layout. Observers cannot fight over
      // viewport size, and presentation must never cancel an admitted Agent.
      const leader = [...this.viewers(page)].find(([, v]) => v.visible && v.ready && v.modern)?.[0];
      if (!current() || page.controller || leader !== ws) return { deferred: true };
      const value = await this.request(page.id, 'viewport', {
        width: input?.width, height: input?.height, deviceProfile: input?.deviceProfile,
      });
      authorize();
      if (!current()) return { deferred: true };
      await this.persist([page.key]);
      return { ...value, deferred: false };
    });
  }
  invokeAutomation(binding, method, input, options) { return invokeWithReceipt(this, binding, method, input, options, () => invokeRemoteAutomation(this, binding, method, input, options)); }
  keyframe(page, bucket = 'fast') {
    const input = page.productionDemand ? { bucket } : undefined;
    void this.request(page.id, 'keyframe', input).catch(() => {});
    // The native keyframe limiter may ignore a new viewer's immediate request.
    // One shared delayed refresh guarantees a decodable keyframe even at idle.
    const timer = bucket === 'slow' ? 'slowKeyTimer' : 'keyTimer';
    if (!page[timer]) {
      page[timer] = setTimeout(() => { page[timer] = null; if (!page.closing && page.painted) void this.request(page.id, 'keyframe', input).catch(() => {}); }, 550);
      page[timer].unref();
    }
  }
  displayPace(page) {
    if (page.productionDemand) { this.production(page); return; }
    if (page.displayRateUnsupported) return;
    const native = this.child;
    const fps = Math.max(5, ...[...this.viewers(page).values()].filter((viewer) => viewer.visible).map((viewer) => viewer.decodeFps ?? 30));
    if (page.closing || !page.live || page.displayFps === fps) return;
    page.displayFps = fps;
    void this.request(page.id, 'display-rate', { fps }).catch((error) => {
      if (this.child !== native) return;
      page.displayFps = undefined;
      if (error.message === 'Unsupported browser command') page.displayRateUnsupported = true;
    });
  }
  production(page) {
    if (page.closing || !page.live) return;
    const plan = this.display.production(page), signature = JSON.stringify(plan), now = performance.now();
    if (page.productionSignature === signature && now - (page.productionSent ?? -Infinity) < 500) return;
    page.productionPending = { plan, signature };
    if (page.productionJob) return;
    const generation = page.visibilityGeneration ?? 0, native = this.child;
    const current = () => !page.closing && page.live && this.child === native && (page.visibilityGeneration ?? 0) === generation;
    page.productionJob = (async () => {
      while (current() && page.productionPending) {
        const next = page.productionPending; page.productionPending = null;
        page.productionEpoch ??= randomUUID();
        await this.request(page.id, 'production', { epoch: page.productionEpoch, revision: (page.productionRevision = (page.productionRevision ?? 0) + 1), ttlMs: 1250, buckets: next.plan });
        if (!current()) return;
        page.productionSignature = next.signature; page.productionSent = performance.now();
      }
    })().catch(() => { page.productionSignature = undefined; this.diagnose('production_update_failed'); })
      .finally(() => { page.productionJob = null; });
  }
  resetVisibility(page) {
    page.displayRateUnsupported = false;
    page.productionPending = null; page.productionSignature = undefined; page.productionEpoch = undefined; page.productionRevision = 0;
    page.displayFps = undefined;
    page.paintRefresh = page.paintedRefresh = 0;
    page.snapshotDocument = undefined;
    page.runtimeEpoch = (page.runtimeEpoch ?? 0) + 1;
    page.visibilityGeneration = (page.visibilityGeneration ?? 0) + 1;
    page.visibilityWake?.(); page.visibilityWake = null; page.visibilityJob = null;
    page.painted = null;
  }
  visibility(page) {
    if (page.visibilityJob) return page.visibilityJob;
    const generation = page.visibilityGeneration ?? 0, child = this.child;
    const current = () => !this.closed && !page.closing && page.live
      && this.child === child && (page.visibilityGeneration ?? 0) === generation;
    const job = (async () => {
      let failures = 0;
      while (current()) {
        const visible = [...this.viewers(page).values()].some((viewer) => viewer.visible);
        const refresh = page.paintRefresh ?? 0;
        if (page.painted === visible && (!visible || (page.paintedRefresh ?? 0) === refresh)) return;
        try {
          await this.request(page.id, 'visible', { visible });
          if (!current()) return;
          page.painted = visible; page.paintedRefresh = refresh; failures = 0;
        } catch (error) {
          if (!current()) return;
          // A failed/unknown outcome cannot be cached as applied. These setters
          // are idempotent; input and composition are never retried here.
          page.painted = null;
          if (error.retryable === false) throw error;
          if (++failures > 3)
            throw unavailable('Browser display unavailable; reconnecting');
          await new Promise((resolve) => {
            const timer = setTimeout(wake, 200 * 2 ** (failures - 1)); timer.unref();
            function wake() { clearTimeout(timer); if (page.visibilityWake === wake) page.visibilityWake = null; resolve(); }
            page.visibilityWake = wake;
          });
        }
      }
    })();
    page.visibilityJob = job;
    void job.finally(() => { if (page.visibilityJob === job) page.visibilityJob = null; }).catch(() => {});
    return job;
  }
  refreshDocumentFrame(page) {
    if (!page.live || !page.document || page.snapshotDocument === page.document) return;
    page.snapshotDocument = page.document;
    if (![...this.viewers(page).values()].some((viewer) => viewer.visible)) return;
    // A document loaded while OSR was parked can leave its old blank bitmap
    // cached. The existing idempotent setter captures the current compositor,
    // including on retained owners; do not restart them or grant input.
    page.paintRefresh = (page.paintRefresh ?? 0) + 1;
    void this.visibility(page).catch(() => this.diagnose('display_refresh_failed'));
  }
  detach(page, ws) {
    this.display.detach(ws);
    const viewer = this.viewers(page).get(ws);
    if (!this.viewers(page).delete(ws)) return;
    viewer?.abort?.abort();
    this.displayPace(page);
    if (page.controller === ws) {
      const token = page.controlToken;
      page.controller = null; page.controlToken = null; page.controlKind = null; page.controlEpoch = (page.controlEpoch ?? 0) + 1;
      for (const request of this.requests.values()) if (request.page === page.id && request.method === 'automation' && request.control === token) request.cancel?.();
      if (!page.closing) void this.controlQueue(page, () => this.request(page.id, 'control', { token: null })).catch(() => {});
    }
    this.controlChanged(page);
    if (!page.closing) void this.visibility(page).catch(() => {});
  }
  retire(page, replying, options) { return retireRemotePage(this, page, replying, options); }
  retryRetirement(page, delay = 1000) {
    if (this.closed || page.retirementTimer) return;
    page.retirementTimer = setTimeout(() => {
      page.retirementTimer = null;
      if (!this.closed) void this.retire(page).catch(() => {});
    }, delay);
    page.retirementTimer.unref();
  }
  async available() {
    if (this.closed) return false;
    // Remote owner readiness belongs to its already-admitted execution target,
    // not to Electron files in this Gateway. The trusted probe must not allocate,
    // launch a browser, or substitute a local runtime after failure.
    if (this.ownerAvailable) {
      const connector = this.ownerConnector;
      if (typeof connector !== "function") return false;
      try {
        const available = await this.ownerAvailable();
        return !this.closed && this.ownerConnector === connector && available === true;
      } catch {
        return false;
      }
    }
    try { await Promise.all([access(this.executable), access(join(this.directory, 'worker.cjs'))]); return !this.closed && process.platform === 'linux'; }
    catch { return false; }
  }
  async start() {
    if (this.closed) throw new Error('Browser service closed');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const requireOpen = () => { if (this.closed) throw new Error('Browser service closed'); };
      await this.load(); requireOpen();
      const available = await this.available(); requireOpen();
      if (!available) throw new Error('Bundled browser runtime unavailable');
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 }); requireOpen();
      if (this.ownerConnector) {
        let child;
        try { child = await this.ownerConnector({ directory: this.directory, dataDirectory: this.dataDirectory }); }
        catch (error) {
          if (error.code === 'BROWSER_OWNER_INCOMPATIBLE') throw error;
          this.diagnose('owner_attach_failed');
          throw unavailable('Browser owner unavailable; reconnecting');
        }
        if (this.closed) { child.kill(); throw new Error('Browser service closed'); }
        this.child = child; this.isolated = false;
        const retire = (event) => {
          if (this.child !== child) return;
          this.child = null; this.starting = null; this.diagnose(event);
          for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(Object.assign(unavailable('Browser owner disconnected'), { retryable: false, outcome: 'unknown' })); }
          this.requests.clear();
          for (const page of this.pages.values()) {
            this.resetVisibility(page); page.live = false; page.painted = false; page.controller = null; page.controlToken = null; page.controlKind = null; page.controlEpoch = (page.controlEpoch ?? 0) + 1;
            for (const ws of this.viewers(page).keys()) ws.close(1011, 'Browser owner disconnected; reconnecting');
          }
          void this.commit(
            (draft) => { for (const record of draft.pages) if (occupied(record)) record.runtime = { ...record.runtime, kind: 'unknown' }; }, { resourcesOnly: true }).catch(() => {});
          child.kill();
        };
        child.on('error', () => retire('owner_transport_error')); child.on('exit', () => retire('owner_detached'));
        child.on('message', (message) => { if (this.child !== child) return;
          if (message.type === 'owner-failure') this.lastBrowserFailure = { event: 'owner_exited', native: message.native };
          else this.receive(message);
        });
        // Only durable logical pages may adopt a live native page. Unknown
        // native IDs are orphans, never a source of new authorization.
        try {
          // A lazy workspace router has not attached every native owner yet.
          // Its missing entries prove nothing about native absence. Snapshot the
          // private handshake before any native/durable await.
          if (child.inventoryComplete !== undefined && typeof child.inventoryComplete !== "boolean")
            throw new Error("Invalid browser owner inventory completeness");
          const inventoryComplete = child.inventoryComplete !== false;
          const inventory = new Map(child.inventory.map((config) => [config.id, config]));
          for (const page of this.pages.values()) {
            const config = inventory.get(page.id); if (!config) continue;
            inventory.delete(page.id); page.live = true; page.painted = false; page.document = config.document;
            page.viewport = { width: config.width, height: config.height, deviceProfile: config.deviceProfile };
            page.url = checkpointUrl(config.navigation?.url); page.controller = null; page.controlToken = null; page.controlKind = null;
            if (Number.isInteger(config.zoom)) page.zoom = config.zoom;
          }
          const requireOwner = () => {
            if (this.closed || this.child !== child) throw unavailable('Browser owner changed during recovery');
          };
          for (const id of inventory.keys()) {
            requireOwner(); await this.request(id, 'close'); requireOwner();
          }
          await this.commit(
            (draft) => {
            requireOwner();
            for (const record of draft.pages) {
              const page = this.pages.get(record.key);
                const kind = page?.live
                  ? "live"
                  : inventoryComplete
                    ? "absent"
                    : occupied(record)
                      ? "unknown"
                      : record.runtime.kind;
                record.runtime = { ...record.runtime, kind };
            }
          }, { resourcesOnly: true });
          requireOwner();
          return;
        } catch (error) { retire('owner_recovery_failed'); throw error; }
      }
      const env = { ...process.env, OPENCRAFT_BROWSER_DATA_DIR: this.dataDirectory };
      // A trusted runtime needs no inherited Node hooks or ambient desktop.
      for (const name of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','DISPLAY','WAYLAND_DISPLAY']) delete env[name];
      // Keep compositing on the CPU while allowing WebGL through software ANGLE.
      // Some mobile pages require a WebGL context even for device detection.
      // SwiftShader is an explicit software backend, not hardware acceleration.
      const flags = ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--disable-gpu',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
      const isolated = process.getuid?.() === 0 && !this.allowNoSandbox;
      this.isolated = isolated;
      let child;
      if (isolated) {
        await prepareBrowserRuntimeAccess(this.directory); requireOpen();
        // Root gateways never run hostile pages as root or silently disable the
        // Chromium sandbox. systemd gives this child a private dynamic UID and
        // mounts only public runtime assets through the root-private release.
        const state = 'opencraft-browser-' + createHash('sha256').update(this.dataDirectory).digest('hex').slice(0, 16);
        this.unit = 'opencraft-browser-' + randomUUID();
        child = this.spawnImpl('systemd-run', ['--pipe', '--wait', '--collect', '--quiet', '--service-type=exec', '--unit=' + this.unit,
          '-p', 'DynamicUser=yes', '-p', 'PrivateTmp=yes', '-p', 'NoNewPrivileges=yes', '-p', 'StateDirectory=' + state, '-p', 'StateDirectoryMode=0700',
          '-p', 'BindReadOnlyPaths=' + this.directory + ':/opt/opencraft-browser',
          '-p', 'Environment=OPENCRAFT_BROWSER_DATA_DIR=/var/lib/' + state,
          '-p', 'Environment=HOME=/var/lib/' + state,
          '/usr/bin/env', '/opt/opencraft-browser/electron/electron', ...flags, '/opt/opencraft-browser/worker.cjs'],
          { env, stdio: ['pipe', 'pipe', 'pipe'] });
      } else {
        child = this.spawnImpl(this.executable, [...flags, ...(this.allowNoSandbox ? ['--no-sandbox'] : []), join(this.directory, 'worker.cjs')],
          { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
      }
      this.child = child;
      const diagnostics = nativeDiagnostics.createNativeDiagnostics();
      let failure;
      let failStartup;
      const retire = (event) => {
        if (this.child !== child) return;
        this.child = null; this.starting = null; this.nativeReconciled = false;
        failure = { event, native: diagnostics.snapshot() };
        this.lastBrowserFailure = failure;
        if (!this.closed) this.diagnose(event);
        failStartup?.(unavailable('Browser process exited during startup'));
        for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(interruptedRequest(request, 'Browser process exited')); }
        this.requests.clear();
        for (const p of this.pages.values()) { this.resetVisibility(p); p.live = false; p.painted = false; p.controller = null; p.controlToken = null; p.controlKind = null; p.controlEpoch = (p.controlEpoch ?? 0) + 1; for (const ws of this.viewers(p).keys()) ws.close(1011, 'Browser process exited; reconnecting'); }
        void this.commit(
          (draft) => { for (const record of draft.pages) if (occupied(record)) record.runtime = { ...record.runtime, kind: 'unknown' }; }, { resourcesOnly: true }).catch(() => {});
        // Retire this transport only. EOF/disconnect asks a still-running owned
        // worker to quit; its late messages/errors cannot touch the replacement.
        child.stdin?.destroy();
        if (!isolated && child.connected) child.disconnect();
      };
      child.on('error', () => retire('process_error'));
      child.on('exit', (code, signal) => {
        retire('process_exited');
        // A pipe error can retire the owner before the OS exit notification.
        if (failure) { failure.code = code; failure.signal = signal; }
      });
      // A write callback does not consume Writable's separate error event.
      // Keep handlers after bootstrap/close so late EPIPE cannot kill Gateway.
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => retire('transport_error'));
      child.on('message', (message) => { if (this.child === child) this.receive(message); });
      if (isolated) {
        const lines = createInterface({ input: child.stdout });
        lines.on('error', () => retire('transport_error'));
        lines.on('line', (line) => { if (this.child !== child) return; try { child.emit('message', JSON.parse(line)); } catch {} });
      }
      child.stderr?.on('data', (chunk) => {
        diagnostics.consume(chunk);
        if (failure) failure.native = diagnostics.snapshot();
      });
      child.stderr?.on('end', () => {
        diagnostics.finish();
        if (failure) failure.native = diagnostics.snapshot();
      });
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const cancel = () => finish(new Error('Browser service closed'));
          const finish = (error) => {
            if (settled) return; settled = true; clearTimeout(timer); child.off('message', ready);
            if (this.cancelStartup === cancel) this.cancelStartup = null;
            error ? reject(error) : resolve();
          };
          failStartup = finish; this.cancelStartup = cancel;
          const ready = (message) => { if (message.type === 'ready') finish(); };
          const timer = setTimeout(() => { child.kill(); finish(unavailable('Browser startup timed out')); }, 15000);
          child.on('message', ready); child.once('error', () => finish(unavailable('Browser process could not start')));
          child.once('exit', () => finish(unavailable('Browser process exited during startup')));
        });
        const requireNative = () => {
          requireOpen();
          if (this.child !== child) throw unavailable('Browser process changed during startup');
        };
        requireNative();
        if (!this.nativeReconciled) {
          await this.commit(
            (draft) => {
            requireNative();
            for (const record of draft.pages) record.runtime = { ...record.runtime, kind: 'absent' };
          }, { resourcesOnly: true });
          requireNative(); this.nativeReconciled = true;
        }
      } catch (error) { retire('startup_failed'); throw error; }
    })();
    const attempt = this.starting;
    try { await attempt; }
    catch (error) { if (this.starting === attempt) this.starting = null; throw error; }
  }
  receive(message) {
    if (message.type === 'result') {
      const request = this.requests.get(message.id); if (!request) return;
      this.requests.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.value); return;
    }
    const p = [...this.pages.values()].find((page) => page.id === message.page);
    if (message.type === 'renderer-gone' && p) {
      this.diagnose('renderer_exited', undefined, message);
      this.resetVisibility(p); p.live = false; p.painted = false; p.controller = null; p.controlToken = null; p.controlKind = null;
      p.controlEpoch = (p.controlEpoch ?? 0) + 1;
      clearTimeout(p.keyTimer); p.keyTimer = null;
      void this.runtimeState(p, 'absent').catch(() => {});
      for (const [id, request] of this.requests) if (request.page === p.id) {
        this.requests.delete(id); clearTimeout(request.timer); request.reject(interruptedRequest(request, 'Browser renderer exited; reconnecting'));
      }
      for (const ws of this.viewers(p).keys()) ws.close(1011, 'Browser renderer exited; reconnecting');
      return;
    }
    if (message.type === 'error' && message.message === 'Browser renderer exited; reload this tab') this.diagnose('renderer_exited');
    if (p && !p.recovering && message.type === 'navigation' && !message.state.isLoading) { p.url = checkpointUrl(message.state.url); this.checkpoint(p.key); }
    if (p && message.type === 'navigation' && !message.state.isLoading) this.refreshDocumentFrame(p);
    if (p && message.type === 'viewport') { p.viewport = { width: message.width, height: message.height, deviceProfile: message.deviceProfile }; this.checkpoint(p.key); }
    if (!p) return;
    if (p && message.type === 'presentation-changed') {
      for (const [ws, observer] of this.presentationObservers) {
        if (observer.ownerId !== p.ownerId || ws.readyState !== WebSocket.OPEN) continue;
        try { observer.authorize(); } catch { ws.close(1008, 'Browser admission expired'); continue; }
        if (ws.bufferedAmount < 65536) ws.send(JSON.stringify({ type: 'presentation-changed', lease: JSON.parse(p.key)[1], metadata: message.metadata }));
      }
    }
    if (message.type === 'input-reset' && typeof message.document === 'string') p.document = message.document;
    const privateEvent = ['ime-state', 'context-menu', 'new-window'].includes(message.type);
    const packet = message.type === 'frame' ? Buffer.from(message.bytes, 'base64') : null;
    const { page, ...event } = message;
    for (const [ws, viewer] of this.viewers(p)) {
      if (ws.readyState !== WebSocket.OPEN ||
        (privateEvent && ws !== p.controller) ||
        (packet && (!viewer.visible || !viewer.ready || (message.bucket ?? 'fast') !== (viewer.bucket ?? 'fast')))) continue;
      try { viewer.authorize(); } catch { ws.close(1008, 'Browser admission expired'); continue; }
      this.display.send(p, ws, viewer, packet, event);
    }
  }

  diagnose(event, method, detail) {
    // A noisy slow viewer must not consume the process/crash diagnostic budget.
    const count = this.diagnosticCounts.get(event) ?? 0;
    if (count >= 20) return;
    this.diagnosticCounts.set(event, count + 1);
    this.diagnosticCount++;
    // Only owned enums and process counters: never request input, actor/page
    // identifiers, URLs, arbitrary native stderr or exception messages.
    console.warn('[opencraft-browser]', JSON.stringify({ event,
      ...(method === 'create' || methods.has(method) ? { method } : {}),
      ...(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure'].includes(detail?.reason) ? { reason: detail.reason } : {}),
      ...(Number.isInteger(detail?.exitCode) && Math.abs(detail.exitCode) < 2147483648 ? { exitCode: detail.exitCode } : {}),
      ...(Number.isInteger(detail?.closeCode) && detail.closeCode >= 1000 && detail.closeCode < 5000 ? { closeCode: detail.closeCode } : {}),
      pendingRequests: this.requests.size }));
  }
  request(page, method, input, control, document, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Browser operation cancelled'), { code: 'CDP_ABORTED', retryable: false, outcome: 'not-dispatched' }));
    if (!this.child || (this.isolated ? this.child.stdin.destroyed : !this.child.connected)) return Promise.reject(unavailable('Browser unavailable'));
    const id = randomUUID(), native = this.child, isolated = this.isolated;
    return new Promise((resolve, reject) => {
      const timeout = method === 'automation' ? Math.min(65000, Math.max(35000, Number(input?.input?.timeoutMs ?? 0) + 5000)) : 20000;
      const send = (message, callback) => isolated ? native.stdin.write(JSON.stringify(message) + '\n', callback) : native.send(message, callback);
      let stopping;
      const finish = (callback) => (value) => { clearTimeout(timer); this.requests.delete(id); signal?.removeEventListener('abort', abort); callback(value); };
      const stop = (error, expired = false) => {
        if (!this.requests.has(id)) return;
        if (method === 'automation' && !stopping) {
          try { send({ id: randomUUID(), page, method: 'cancelAutomation', input: { requestId: id } }, () => {}); } catch {}
        }
        stopping ??= error;
        // Cancellation is an intent, not the native provider's completion.
        // Keep the correlation/queue occupied until its original reply, a
        // transport failure or the existing unknown-outcome deadline.
        if (expired) finish(reject)(stopping);
      };
      const abort = () => stop(Object.assign(new Error('Browser operation cancelled; inspect before repeating an effect'), { code: 'CDP_ABORTED', retryable: false, outcome: 'unknown' }));
      const timer = setTimeout(() => { this.diagnose('request_timeout', method); stop(Object.assign(unavailable(`Browser operation timed out (${method})`), { retryable: false, outcome: 'unknown' }), true); }, timeout);
      timer.unref(); this.requests.set(id, { page, method, control,
        resolve: (value) => (stopping ? finish(reject)(stopping) : finish(resolve)(value)),
        reject: (error) => finish(reject)(stopping ?? error), timer, cancel: abort });
      signal?.addEventListener('abort', abort, { once: true });
      const failed = (error) => { if (error && this.requests.has(id)) finish(reject)(Object.assign(unavailable('Browser disconnected'), { retryable: false, outcome: 'unknown' })); };
      try {
        send({ id, page, method, input, control, document }, failed);
      } catch (error) { failed(error); }
    });
  }
  upgrade(request, socket, head, { ownerId, authorize = () => {}, track = () => {} }) {
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.sockets.add(ws); track(ws);
      let page = null, pending = 0, opening = false;
      const automationCalls = new Map();
      const reply = (id, value, error) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id, value,
        ...(error ? { error: { code: error.code || 'BROWSER_ERROR', message: error.message, retryable: !!error.retryable, outcome: error.outcome } } : {}) })); };
      ws.on('error', () => ws.terminate());
      ws.on('message', async (bytes, binary) => {
        if (binary) { this.diagnose('invalid_request'); ws.close(1008, 'Invalid browser request'); return; }
        if (pending >= 128) { this.diagnose('input_backlog'); ws.close(1013, 'Browser input backlog; reconnecting'); return; }
        let message;
        pending++;
        let releaseAttachment;
        try {
          authorize(); message = JSON.parse(bytes.toString());
          if (typeof message.id !== 'string' || message.id.length > 100) throw new Error('Invalid request id');
          if (message.method === 'presentation') { this.presentationObservers.set(ws, { ownerId, authorize }); reply(message.id, await this.presentation(ownerId, message.input, authorize)); return; }
          if (message.method === 'catalog') { reply(message.id, await this.catalog(ownerId, authorize)); return; }
          if (message.method === 'state') {
            this.metadataObservers.set(ws, { ownerId, authorize });
            if (message.subscribe === true) this.metadataPeers.set(ws, { ownerId, authorize });
            const value = await this.metadata(ownerId, message.input, authorize, message.retirementCursor, message.retirementReferences, ws); authorize(); reply(message.id, value); return;
          }
          if (message.method === 'metadata-digest') {
            this.metadataObservers.set(ws, { ownerId, authorize });
            const value = await this.metadataDigest(ownerId, message.input, authorize, message.retirementReferences); authorize(); reply(message.id, value); return;
          }
          if (message.method === 'presentation-ack') {
            await this.load(); authorize();
            reply(message.id, await acknowledgePresentation(this, ownerId, message.input, authorize)); return;
          }
          if (message.method === 'discard') {
            if (!/^[a-zA-Z0-9-]{20,128}$/.test(message.input?.lease ?? '')) throw new Error('Invalid browser lease');
            await this.load(); authorize();
            const key = JSON.stringify([ownerId, message.input.lease]);
            const target = this.pages.get(key);
            if (target) await this.retire(target, undefined, { admit: authorize });
            else {
              await this.commit(
                (draft) => { authorize(); if (!draft.retired.includes(key)) draft.retired.push(key); }, { ownerId, keys: [key] });
            }
            reply(message.id); return;
          }
          if (message.method === 'open') {
            if (page || opening) throw new Error('Browser already opened');
            opening = true;
            if (!/^[a-zA-Z0-9-]{20,128}$/.test(message.input?.lease ?? '')) throw new Error('Invalid browser lease');
            const key = JSON.stringify([ownerId, message.input.lease]);
            // Complete an earlier bootstrap before handing its live page to a
            // replacement. Otherwise two create/config/cleanup paths can race.
            releaseAttachment = await this.acquirePageActivation(key);
            authorize();
            if (this.closed || ws.readyState !== WebSocket.OPEN) return;
            await this.load(); authorize();
            if (await this.store.hasRetirement(key)) throw sessionError('SESSION_CLOSED', 'Browser tab is closed');
            authorize();
            this.assertConversation(ownerId, key);
            const existing = this.pages.get(key);
            if (existing?.closing) throw new Error('Browser tab is closing');
            const modern = message.input.multiView === true;
            if (!modern && existing && this.viewers(existing).size) {
              if (message.input.takeover !== true || [...this.viewers(existing).values()].some((viewer) => viewer.modern)) throw new Error('Browser page already attached; reload OpenCraft for shared viewing');
              for (const old of this.viewers(existing).keys()) { this.detach(existing, old); old.close(4009, 'Browser viewer transferred'); }
            }
            if (existing && this.viewers(existing).size >= 16) throw new Error('Browser viewer limit reached');
            try {
              await this.activatePage({ ownerId, key, input: message.input, modern, authorize,
                attach: (target) => {
                  page = target;
                  this.viewers(page).set(ws, { visible: !modern || message.input.visible === true, visibilityEpoch: 0, modern, documentInput: message.input.documentInput === true, inputAcknowledgements: message.input.inputAcknowledgements === true, authorize, abort: new AbortController(), ready: false });
                },
                detach: (target) => this.detach(target, ws),
                finish: async (target, { config, resumed, restored, initialized }) => {
                  if (target.closing) throw sessionError('SESSION_CLOSING', 'Browser tab is closing');
                  if (ws.readyState !== WebSocket.OPEN) { this.detach(target, ws); return; }
                  if (!modern) await this.control(target, ws, { action: 'human', takeover: true }, authorize);
                  this.controlChanged(target);
                  reply(message.id, { ...config, document: target.document ?? config.document, documentInput: typeof (target.document ?? config.document) === 'string', inputAcknowledgements: message.input.inputAcknowledgements === true, inputWindow: 12, resumed, restored, multiView: true, initialized, layoutViewport: true, control: this.controlState(target, ws) });
                  const attached = this.viewers(target).get(ws); if (attached) {
                    attached.ready = true; this.controlChanged(target); this.displayPace(target);
                    if (message.input.mediaFeedback === 1) this.display.attach(target, ws, attached, message.input.mediaStage === 'rendered' ? 'rendered' : 'received');
                    this.displayPace(target); if (attached.visible) this.keyframe(target);
                  }
                },
              });
            } catch (error) { page = null; throw error; }
            opening = false; return;
          }
          if (!page || this.pages.get(page.key) !== page || !this.viewers(page).has(ws)) throw new Error('Browser page not opened');
          authorize(); this.assertConversation(page.ownerId, page.key); const target = page, viewer = this.viewers(target).get(ws);
          if (message.method === 'cancelAutomation') {
            if (typeof message.input?.requestId !== 'string' || message.input.requestId.length > 100) throw new Error('Invalid automation cancellation');
            const original = automationCalls.get(message.input.requestId);
            if (original?.page === target) original.abort.abort();
            reply(message.id); return;
          }
          if (message.method === 'mediaDiagnostics') {
            const config = await this.request(target.id, 'snapshot'); authorize();
            reply(message.id, { media: this.display.snapshot(ws), productionDemand: !!target.productionDemand, native: config.production ?? null }); return;
          }
          if (message.method === 'mediaFeedback') { this.display.feedback(ws, message.input); return; }
          if (message.method === 'control') { reply(message.id, await this.control(target, ws, message.input, authorize)); return; }
          if (message.method === 'layoutViewport') { reply(message.id, await this.layoutViewport(target, ws, message.input, authorize)); return; }
          if (!methods.has(message.method)) throw new Error('Unsupported browser command');
          if (message.method === 'close') {
            await this.retire(target, ws, { admit: authorize }); if (page === target) page = null;
            authorize(); reply(message.id); ws.close(1000, 'Browser tab closed'); return;
          }
          if (target.closing) throw new Error('Browser tab is closing');
          if (message.method === 'visible') {
            viewer.visible = message.input?.visible === true;
            if (!viewer.visible) viewer.visibilityEpoch = (viewer.visibilityEpoch ?? 0) + 1;
            if (!viewer.visible && target.controller === ws && target.controlKind === 'human')
              await this.control(target, ws, { action: 'release', token: target.controlToken }, authorize);
            await this.visibility(target); this.displayPace(target); this.controlChanged(target);
            if (viewer.visible) this.keyframe(target);
            return;
          }
          if (message.method === 'keyframe') { this.keyframe(target, viewer.bucket ?? 'fast'); return; }
          const readOnly = ['capture', 'copy'].includes(message.method) ||
            (message.method === 'automation' && ['inspect', 'readContext', 'wait', 'annotatePick', 'annotateRegion', 'annotateText', 'annotateStyles'].includes(message.input?.method));
          const control = viewer.modern ? message.control : target.controlToken;
          if (!readOnly && (target.controller !== ws || !control || control !== target.controlToken))
            throw Object.assign(new Error('Browser control changed; start a new interaction'), { code: 'CONTROL_LOST', retryable: true });
          const documentBound = ['input', 'text', 'ime', 'automation', 'annotation-overlay'].includes(message.method);
          const document = documentBound ? (viewer.documentInput ? message.document : target.document) : undefined;
          if (documentBound && viewer.documentInput && (typeof document !== 'string' || document !== target.document))
            throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
          let value;
          if (message.method === 'automation') {
            if (automationCalls.has(message.id)) throw new Error('Automation request is already pending');
            const original = { page: target, abort: new AbortController() };
            automationCalls.set(message.id, original);
            try {
              value = await this.request(target.id, message.method, message.input, readOnly ? undefined : control, document,
                { signal: viewer.abort ? AbortSignal.any([viewer.abort.signal, original.abort.signal]) : original.abort.signal });
            } finally { if (automationCalls.get(message.id) === original) automationCalls.delete(message.id); }
          } else value = await this.request(target.id, message.method, message.input, readOnly ? undefined : control, document);
          authorize();
          if (message.method === 'automation' && documentBound && document !== target.document)
            throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
          if (page !== target || !this.viewers(target).has(ws) || this.pages.get(target.key) !== target || ws.readyState !== WebSocket.OPEN) return;
          if (message.method === 'zoom') { target.zoom = Number(message.input.percent); await this.persist([target.key]); }
          if (['navigate', 'viewport'].includes(message.method)) await this.persist([target.key]);
          if (!quietMethods.has(message.method) || (message.method === "input" && viewer.inputAcknowledgements)) reply(message.id, value);
        } catch (error) { opening = false;
          if (message?.id) reply(message.id, null, error); else ws.close(1008, 'Invalid browser request');
          // Quiet setters have no client waiter. Exhausted display recovery
          // must reattach rather than silently leave this viewer out of sync.
          if (message?.method === 'visible' && error.code === 'BROWSER_UNAVAILABLE')
            ws.close(1013, 'Browser display unavailable; reconnecting');
        }
        finally { releaseAttachment?.(); pending--; }
      });
      ws.on('close', (code) => {
        this.presentationObservers.delete(ws); this.metadataObservers.delete(ws); this.metadataPeers.delete(ws);
        this.diagnose('viewer_disconnected', undefined, { closeCode: code });
        this.sockets.delete(ws);
        this.metadataPeers.delete(ws);
        if (!page) return;
        this.detach(page, ws);
      });
    });
  }
  close() {
    if (this.closed) return this.persistence;
    if (this.loaded) void this.persist().catch(() => {});
    this.closed = true;
    this.display.close();
    this.cancelStartup?.();
    this.diagnose('gateway_shutdown');
    for (const ws of this.sockets) {
      ws.close(1012, 'Browser connection restarting');
      const timer = setTimeout(() => ws.terminate(), 2000); timer.unref();
      ws.once('close', () => clearTimeout(timer));
    }
    clearTimeout(this.checkpointTimer); this.checkpointKeys?.clear();
    // Private remote transports own asynchronous proxy/attachment cleanup.
    // Drain them before releasing the durable browser writer to a successor.
    const native = this.child;
    let ownerDrainFailed = false;
    const drainingOwner =
      !this.isolated && typeof native?.close === "function"
        ? Promise.resolve()
            .then(() => native.close())
            .catch(() => {
              ownerDrainFailed = true;
            })
        : Promise.resolve();
    const releasing = Promise.allSettled([drainingOwner, Promise.resolve(this.loading)]).catch(() => {}).then(() => this.store?.tail).then(() => this.store?.close()).finally(() => this.releaseWriter?.());
    this.persistence = releasing.catch(() => {})
      .then(() => {
        if (ownerDrainFailed) throw new Error("Browser owner cleanup unconfirmed");
      });
    void this.persistence.catch(() => {});
    for (const page of this.pages.values()) { this.resetVisibility(page); clearTimeout(page.retirementTimer); clearTimeout(page.keyTimer); }
    for (const request of this.requests.values()) {
      if (request.method === 'automation') request.cancel?.();
      else { clearTimeout(request.timer); request.reject(new Error('Browser service closed')); }
    }
    this.requests.clear();
    if (this.isolated) this.child?.stdin.end(); else this.child?.kill();
    this.server.close();
    return this.persistence;
  }
}
