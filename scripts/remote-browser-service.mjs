import { prepareBrowserRuntimeAccess } from './remote-browser-access.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import nativeDiagnostics from './remote-browser/diagnostics.cjs';
import displayFlow from './remote-browser/display.cjs';
import { BrowserStateFile, acquireBrowserStateWriter, sessionError, sessionLink, linkedSessions, occupied } from './remote-browser-state-file.mjs';
import { startBrowserOwner } from './remote-browser-owner.mjs';

const methods = new Set(['viewport', 'navigate', 'reload', 'stop', 'back', 'forward', 'visible', 'keyframe', 'capture', 'zoom', 'input', 'text', 'ime', 'copy', 'automation', 'close']);
const quietMethods = new Set(['visible', 'keyframe', 'input', 'text']);
const unavailable = message => Object.assign(new Error(message), { code: 'BROWSER_UNAVAILABLE', retryable: true });
// The worker's bootstrap document is an empty tab, not an external URL.
const checkpointUrl = url => url === 'about:blank' || url === '' ? null : url;
function removedStorageLeases(previous, next) {
  const parse = value => {
    if (typeof value !== 'string') return null;
    try {
      const entries = JSON.parse(value);
      if (!entries || Array.isArray(entries) || typeof entries !== 'object') return null;
      const leases = Object.values(entries);
      if (leases.some(lease => typeof lease !== 'string' || !/^browser[:-][a-zA-Z0-9-]+$/.test(lease))) return null;
      return new Set(leases.map(lease => lease.replace(':', '-')));
    } catch { return null; }
  };
  const before = parse(previous), after = parse(next);
  return before && after ? [...before].filter(lease => !after.has(lease)) : [];
}
/** Gateway-authorized page leases, with an independent managed Linux owner.
 * A client gets only its own page port,
 * never a CDP endpoint, filesystem path or arbitrary JavaScript evaluator. */
export class RemoteBrowserService {
  constructor({ root, dataDirectory, executable, allowNoSandbox = false, spawnImpl = spawn,
    ownerConnector = process.platform === 'linux' && process.getuid?.() === 0 && !allowNoSandbox && spawnImpl === spawn ? startBrowserOwner : null }) {
    this.directory = join(root, 'runtime/browser');
    this.executable = executable ?? join(this.directory, 'electron/electron');
    this.dataDirectory = join(dataDirectory, 'remote-browser');
    this.allowNoSandbox = allowNoSandbox;
    this.spawnImpl = spawnImpl;
    this.ownerConnector = ownerConnector;
    this.pages = new Map(); this.requests = new Map(); this.sockets = new Set();
    this.attachments = new Map();
    this.states = new Map(); this.retiredLeases = new Set(); this.persistence = Promise.resolve();
    this.diagnosticCount = 0;
    this.diagnosticCounts = new Map();
    this.display = displayFlow.createDisplayFlow({ keyframe: page => this.keyframe(page), diagnose: event => this.diagnose(event), pace: page => this.displayPace(page) });
    this.server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 });
  }
  async load() {
    this.loading ??= (async () => {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
      this.releaseWriter = await acquireBrowserStateWriter(this.dataDirectory);
      let saved;
      try { saved = JSON.parse(await readFile(join(this.dataDirectory, 'tabs.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') saved = { schemaVersion: 1, pages: [], retired: [], states: [] }; else throw new Error('Browser state could not be read'); }
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.pages) || !Array.isArray(saved.states)) throw new Error('Unsupported browser state');
      for (const p of saved.pages) {
        if (typeof p.ownerId !== 'string' || typeof p.key !== 'string' || p.id !== createHash('sha256').update(p.key).digest('hex')
          || JSON.parse(p.key)[0] !== p.ownerId) throw new Error('Invalid browser state');
        p.lifecycle ??= p.closing ? 'closing' : 'open';
        // A loaded recovery record says nothing about current native residency.
        // Keep its reservation until the exclusive owner handshake reconciles it.
        if (p.runtime?.kind !== 'absent') p.runtime = { ...p.runtime, kind: this.ownerConnector ? 'unknown' : 'absent' };
        p.link ??= sessionLink(saved.states.find(([owner]) => owner === p.ownerId)?.[1], JSON.parse(p.key)[1]);
        this.pages.set(p.key, { ...p, url: checkpointUrl(p.url), controller: null, live: false });
      }
      if (saved.retired !== undefined && (!Array.isArray(saved.retired) || saved.retired.some(key => {
        if (typeof key !== 'string') return true;
        try { const pair = JSON.parse(key); return !Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'string'); } catch { return true; }
      }))) throw new Error('Invalid browser retirement state');
      saved.retired ??= [];
      this.retiredLeases = new Set(saved.retired);
      for (const [owner, state] of saved.states) this.states.set(owner, state);
      this.store = new BrowserStateFile(this.dataDirectory, saved);
      this.loaded = true;
      for (const page of this.pages.values()) if (page.closing) this.retryRetirement(page, 0);
    })();
    const attempt = this.loading;
    try { return await attempt; }
    catch (error) {
      // A predecessor may still be flushing during managed handover. Busy is
      // transient; corrupt state stays failed closed and is never replaced.
      if (error.code === 'BROWSER_UNAVAILABLE' && this.loading === attempt) this.loading = null;
      throw error;
    }
  }
  commit(reduce) {
    if (this.closed) return Promise.reject(new Error('Browser service closed'));
    const operation = this.store.transact(reduce);
    this.persistence = this.store.tail;
    return operation;
  }
  persist() {
    // Checkpoints may update recovery configuration of committed sessions only.
    // In-flight native state is never inferred from the mutable viewer Map.
    const checkpoints = [...this.pages.values()].map(({ key, url, viewport, zoom }) => ({ key, url, viewport, zoom }));
    return this.commit(draft => {
      for (const value of checkpoints) {
        const record = draft.pages.find(p => p.key === value.key);
        if (record && record.lifecycle !== 'closed') Object.assign(record, value);
      }
    });
  }
  async catalog(ownerId, authorize) {
    await this.load(); await this.store.tail; authorize();
    return { sessions: this.store.current.pages.filter(p => p.ownerId === ownerId && p.lifecycle !== 'closed').map(p => ({
      sessionId: p.id, lease: JSON.parse(p.key)[1], lifecycle: p.lifecycle,
      runtime: p.runtime?.kind ?? 'unknown', link: p.link ?? null, url: p.url,
      createdAt: p.createdAt ?? null,
    })), capacity: { limit: 64, used: this.store.current.pages.filter(occupied).length, accountLimit: 16,
      accountUsed: this.store.current.pages.filter(p => p.ownerId === ownerId && occupied(p)).length } };
  }
  async reserve(ownerId, key, input, authorize) {
    return this.commit(draft => {
      authorize();
      if (draft.retired.includes(key)) throw sessionError('SESSION_CLOSED', 'Browser tab is closed');
      let record = draft.pages.find(p => p.key === key);
      const state = draft.states.find(([owner]) => owner === ownerId)?.[1];
      const link = sessionLink(state, JSON.parse(key)[1]);
      if (input.metadataRequired && !link) throw sessionError('STATE_CONFLICT', 'Browser tab metadata has not been committed; reload to synchronize');
      if (record?.lifecycle === 'closing') throw sessionError('SESSION_CLOSING', 'Browser tab is closing');
      const page = this.pages.get(key);
      if (record?.runtime?.kind === 'unknown' && !page?.live)
        throw sessionError('RUNTIME_UNKNOWN', 'Browser page outcome is being reconciled; reconnect to check again', true);
      if (!record || !occupied(record)) {
        const used = draft.pages.filter(occupied);
        if (used.filter(p => p.ownerId === ownerId).length >= 16)
          throw sessionError('ACCOUNT_CAPACITY', 'Your active browser page limit (16) is reached; close a page in Browser resources');
        if (used.length >= 64)
          throw sessionError('RUNTIME_CAPACITY', 'Shared browser capacity (64) is full; use Browser resources to manage your pages', true);
      }
      if (!record) {
        if (draft.pages.filter(p => p.ownerId === ownerId).length >= 256) throw sessionError('SESSION_CAPACITY', 'Your saved browser session limit (256) is reached; close a session in Browser resources');
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
    });
  }
  async runtimeState(page, kind, epoch = page.runtimeEpoch ?? 0) {
    return this.commit(draft => {
      const record = draft.pages.find(p => p.key === page.key);
      if (!record || (page.runtimeEpoch ?? 0) !== epoch) return;
      // A close intent wins over every late create/config ACK.
      if (record.lifecycle !== 'open' && kind === 'live') return;
      record.runtime = { ...record.runtime, kind };
      if (kind === 'live') { record.url = page.url; record.viewport = page.viewport; record.zoom = page.zoom; }
    });
  }
  checkpoint() {
    if (this.checkpointTimer || this.closed) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      void this.persist().catch(() => {
        for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'error', message: 'Browser recovery state could not be saved' }));
      });
    }, 150);
    this.checkpointTimer.unref();
  }
  async metadata(ownerId, input, authorize) {
    await this.load();
    if (input === undefined) {
      await this.store.tail; authorize();
      const previous = this.store.current.states.find(([owner]) => owner === ownerId)?.[1] ?? { revision: 0, values: {} };
      return { ...previous, scope: createHash('sha256').update(this.dataDirectory + '\0' + ownerId).digest('hex') };
    }
    const retiring = [];
    const result = await this.commit(draft => {
      if (this.closed) throw new Error('Browser service closed');
      authorize();
      const previous = draft.states.find(([owner]) => owner === ownerId)?.[1] ?? { revision: 0, values: {} };
      const scope = createHash('sha256').update(this.dataDirectory + '\0' + ownerId).digest('hex');
      if (input.scope !== scope) throw sessionError('STATE_CONFLICT', 'Browser account changed; reload to synchronize');
      if (!['pages', 'tabs', 'storage', 'bindings'].includes(input.key) || typeof input.value !== 'string' || input.value.length > 64 * 1024
        || !/^[a-zA-Z0-9-]{20,100}$/.test(input.mutationId ?? '')) throw new Error('Invalid browser metadata');
      const fingerprint = createHash('sha256').update(JSON.stringify([input.key, input.value])).digest('hex');
      const receipt = previous.receipts?.find(r => r.id === input.mutationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw sessionError('OPERATION_CONFLICT', 'Browser operation ID reused with different content');
        return { revision: receipt.revision, keyRevision: receipt.keyRevision };
      }
      if (input.mutationId === previous.lastMutation && !previous.receipts) return { revision: previous.revision };
      if (input.expectedKeyRevision !== undefined ? input.expectedKeyRevision !== (previous.keyRevisions?.[input.key] ?? 0) : input.expectedRevision !== previous.revision) throw sessionError('STATE_CONFLICT', 'Browser state changed in another client; reload to synchronize');
      const keyRevision = (previous.keyRevisions?.[input.key] ?? 0) + 1;
      const next = { revision: previous.revision + 1, keyRevisions: { ...previous.keyRevisions, [input.key]: keyRevision }, lastMutation: input.mutationId,
        values: { ...previous.values, [input.key]: input.value },
        receipts: [...(previous.receipts ?? []), { id: input.mutationId, fingerprint, revision: previous.revision + 1, keyRevision }].slice(-256) };
      // Old receipts can never execute again: their original CAS revision is
      // below the monotonically increasing revision even after compaction.
      draft.states = draft.states.filter(([owner]) => owner !== ownerId); draft.states.push([ownerId, next]);
      for (const record of draft.pages.filter(p => p.ownerId === ownerId)) {
        const link = sessionLink(next, JSON.parse(record.key)[1]);
        if (link) record.link = link;
      }
      // Import complete legacy projections into the canonical directory in the
      // same commit as their final dependency. Listing does not reserve native.
      for (const candidate of linkedSessions(ownerId, next)) {
        if (draft.retired.includes(candidate.key) || draft.pages.some(p => p.key === candidate.key)) continue;
        if (draft.pages.filter(p => p.ownerId === ownerId).length >= 256) throw sessionError('SESSION_CAPACITY', 'Your saved browser session limit (256) is reached');
        draft.pages.push({ ...candidate, id: createHash('sha256').update(candidate.key).digest('hex'), ownerId,
          lifecycle: 'open', version: 1, createdAt: Date.now(), zoom: 100, runtime: { kind: 'absent', generation: 0 } });
      }
      // Compatibility close intent for old clients. Only explicit removal of a
      // previously committed reference counts; missing/malformed maps do not.
      for (const lease of input.key === 'storage' ? removedStorageLeases(previous.values.storage, input.value) : []) {
        const key = JSON.stringify([ownerId, lease]);
        if (!draft.retired.includes(key)) draft.retired.push(key);
        const record = draft.pages.find(p => p.key === key);
        if (record) { record.lifecycle = 'closing'; record.closing = true; record.runtime = { ...record.runtime, kind: 'stopping' }; retiring.push(key); }
      }
      return { revision: next.revision, keyRevision };
    });
    this.states = new Map(this.store.current.states); this.retiredLeases = new Set(this.store.current.retired);
    for (const record of this.store.current.pages) if (!this.pages.has(record.key))
      this.pages.set(record.key, { ...record, controller: null, live: false });
    for (const key of retiring) { const page = this.pages.get(key); if (page) { page.closing = true; this.retryRetirement(page, 0); } }
    return result;
  }
  viewers(page) { return page.viewers ??= new Map(); }
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
      || viewer?.visible && (viewer.visibilityEpoch ?? 0) === intent;
    return this.controlQueue(page, async () => {
      authorize();
      if (page.closing || !this.viewers(page).has(ws) || ws.readyState !== WebSocket.OPEN) throw new Error('Browser viewer closed');
      if (!['human', 'agent', 'release'].includes(input?.action)) throw new Error('Invalid browser control request');
      if (!humanCurrent()) throw Object.assign(new Error('Browser interaction ended'), { code: 'CONTROL_LOST', retryable: true });
      const release = input.action === 'release';
      if (release && (page.controller !== ws || input.token !== page.controlToken)) return this.controlState(page, ws);
      if (!release && page.controller === ws && page.controlKind === input.action) return this.controlState(page, ws);
      if (!release && page.controller && (input.action === 'agent' || input.takeover !== true))
        throw Object.assign(new Error('Browser is controlled elsewhere; release control before Agent writes'), { code: 'CONTROL_BUSY', retryable: true });
      page.controller = null; page.controlToken = null; page.controlKind = null;
      const epoch = page.controlEpoch = (page.controlEpoch ?? 0) + 1;
      this.controlChanged(page);
      const token = release ? null : randomUUID();
      // Ordered with native input/automation: old queued commands are fenced at
      // dispatch, and pressed contacts/keys/composition retire before the grant.
      await this.request(page.id, 'control', { token }); authorize();
      if (page.closing || this.viewers(page).get(ws) !== viewer || ws.readyState !== WebSocket.OPEN || !humanCurrent()) {
        await this.request(page.id, 'control', { token: null });
        throw Object.assign(new Error('Browser interaction ended'), { code: 'CONTROL_LOST', retryable: true });
      }
      if (!release) { page.controller = ws; page.controlToken = token; page.controlKind = input.action; }
      this.controlChanged(page);
      if (!release) void this.request(page.id, 'observe').catch(() => {});
      return { ...this.controlState(page, ws), epoch };
    });
  }
  keyframe(page) {
    void this.request(page.id, 'keyframe').catch(() => {});
    // The native keyframe limiter may ignore a new viewer's immediate request.
    // One shared delayed refresh guarantees a decodable keyframe even at idle.
    if (!page.keyTimer) {
      page.keyTimer = setTimeout(() => { page.keyTimer = null; if (!page.closing && page.painted) void this.request(page.id, 'keyframe').catch(() => {}); }, 550);
      page.keyTimer.unref();
    }
  }
  displayPace(page) {
    const fps = Math.max(5, ...[...this.viewers(page).values()].filter(viewer => viewer.visible).map(viewer => viewer.decodeFps ?? 30));
    if (page.closing || !page.live || page.displayFps === fps) return;
    page.displayFps = fps;
    void this.request(page.id, 'display-rate', { fps }).catch(() => { page.displayFps = undefined; });
  }
  resetVisibility(page) {
    page.displayFps = undefined;
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
        const visible = [...this.viewers(page).values()].some(viewer => viewer.visible);
        if (page.painted === visible) return;
        try {
          await this.request(page.id, 'visible', { visible });
          if (!current()) return;
          page.painted = visible; failures = 0;
        } catch (error) {
          if (!current()) return;
          // A failed/unknown outcome cannot be cached as applied. These setters
          // are idempotent; input and composition are never retried here.
          page.painted = null;
          if (error.retryable === false) throw error;
          if (++failures > 3)
            throw unavailable('Browser display unavailable; reconnecting');
          await new Promise(resolve => {
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
  detach(page, ws) {
    this.display.detach(ws);
    if (!this.viewers(page).delete(ws)) return;
    this.displayPace(page);
    if (page.controller === ws) {
      page.controller = null; page.controlToken = null; page.controlKind = null; page.controlEpoch = (page.controlEpoch ?? 0) + 1;
      if (!page.closing) void this.controlQueue(page, () => this.request(page.id, 'control', { token: null })).catch(() => {});
    }
    this.controlChanged(page);
    if (!page.closing) void this.visibility(page).catch(() => {});
  }
  retire(page, replying) {
    if (page.retirement) return page.retirement;
    page.closing = true; this.resetVisibility(page);
    clearTimeout(page.keyTimer); page.keyTimer = null;
    for (const ws of this.viewers(page).keys()) if (ws !== replying) ws.close(1000, 'Browser tab closed');
    this.retiredLeases.add(page.key);
    clearTimeout(page.retirementTimer); page.retirementTimer = null;
    page.retirement = (async () => {
      await this.commit(draft => {
        if (!draft.retired.includes(page.key)) draft.retired.push(page.key);
        const record = draft.pages.find(p => p.key === page.key);
        if (record) { record.lifecycle = 'closing'; record.closing = true; record.runtime = { ...record.runtime, kind: 'stopping', closeOperationId: record.runtime?.closeOperationId ?? randomUUID() }; }
      });
      // A close is a tab-owner operation, not a viewer reply. Once accepted it
      // must finish even if the viewer disconnects while native work awaits.
      if (page.creating) await page.creating.catch(() => {});
      await this.start();
      // Even an unknown create must cross an acknowledged retirement barrier.
      await this.request(page.id, 'close');
      page.live = false;
      if (this.pages.get(page.key) === page) this.pages.delete(page.key);
      page.controller = null; this.viewers(page).clear();
      await this.commit(draft => { draft.pages = draft.pages.filter(p => p.key !== page.key); });
      // A stale runtime remains pinned while any Tab exists. Releasing an idle
      // transport lets the next open safely upgrade an empty native owner.
      if (this.ownerConnector && this.child?.runtimeCurrent === false && !this.pages.size
        && !this.requests.size && !this.attachments.size) {
        const child = this.child; this.child = null; this.starting = null; child.kill();
      }
    })().catch(error => { page.retirement = null; this.retryRetirement(page); throw error; });
    return page.retirement;
  }
  retryRetirement(page, delay = 1000) {
    if (this.closed || page.retirementTimer) return;
    page.retirementTimer = setTimeout(() => {
      page.retirementTimer = null;
      if (!this.closed) void this.retire(page).catch(() => {});
    }, delay);
    page.retirementTimer.unref();
  }
  async available() {
    try { await Promise.all([access(this.executable), access(join(this.directory, 'worker.cjs'))]); return process.platform === 'linux'; }
    catch { return false; }
  }
  async start() {
    if (this.closed) throw new Error('Browser service closed');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.load();
      if (!await this.available()) throw new Error('Bundled browser runtime unavailable');
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
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
        const retire = event => {
          if (this.child !== child) return;
          this.child = null; this.starting = null; this.diagnose(event);
          for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(unavailable('Browser owner disconnected')); }
          this.requests.clear();
          for (const page of this.pages.values()) {
            this.resetVisibility(page); page.live = false; page.painted = false; page.controller = null; page.controlToken = null; page.controlKind = null; page.controlEpoch = (page.controlEpoch ?? 0) + 1;
            for (const ws of this.viewers(page).keys()) ws.close(1011, 'Browser owner disconnected; reconnecting');
          }
          void this.commit(draft => { for (const record of draft.pages) if (occupied(record)) record.runtime = { ...record.runtime, kind: 'unknown' }; }).catch(() => {});
          child.kill();
        };
        child.on('error', () => retire('owner_transport_error')); child.on('exit', () => retire('owner_detached'));
        child.on('message', message => { if (this.child !== child) return;
          if (message.type === 'owner-failure') this.lastBrowserFailure = { event: 'owner_exited', native: message.native };
          else this.receive(message);
        });
        // Only durable logical pages may adopt a live native page. Unknown
        // native IDs are orphans, never a source of new authorization.
        const inventory = new Map(child.inventory.map(config => [config.id, config]));
        for (const page of this.pages.values()) {
          const config = inventory.get(page.id); if (!config) continue;
          inventory.delete(page.id); page.live = true; page.painted = false; page.document = config.document;
          page.viewport = { width: config.width, height: config.height, deviceProfile: config.deviceProfile };
          page.url = checkpointUrl(config.navigation?.url); page.controller = null; page.controlToken = null; page.controlKind = null;
          if (Number.isInteger(config.zoom)) page.zoom = config.zoom;
        }
        for (const id of inventory.keys()) await this.request(id, 'close');
        await this.commit(draft => {
          for (const record of draft.pages) {
            const page = this.pages.get(record.key);
            record.runtime = { ...record.runtime, kind: page?.live ? 'live' : 'absent' };
          }
        });
        return;
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
        await prepareBrowserRuntimeAccess(this.directory);
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
      const retire = event => {
        if (this.child !== child) return;
        this.child = null; this.starting = null; this.nativeReconciled = false;
        failure = { event, native: diagnostics.snapshot() };
        this.lastBrowserFailure = failure;
        if (!this.closed) this.diagnose(event);
        failStartup?.(unavailable('Browser process exited during startup'));
        for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(unavailable('Browser process exited')); }
        this.requests.clear();
        for (const p of this.pages.values()) { this.resetVisibility(p); p.live = false; p.painted = false; p.controller = null; p.controlToken = null; p.controlKind = null; p.controlEpoch = (p.controlEpoch ?? 0) + 1; for (const ws of this.viewers(p).keys()) ws.close(1011, 'Browser process exited; reconnecting'); }
        void this.commit(draft => { for (const record of draft.pages) if (occupied(record)) record.runtime = { ...record.runtime, kind: 'unknown' }; }).catch(() => {});
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
      child.on('message', message => { if (this.child === child) this.receive(message); });
      if (isolated) {
        const lines = createInterface({ input: child.stdout });
        lines.on('error', () => retire('transport_error'));
        lines.on('line', line => { if (this.child !== child) return; try { child.emit('message', JSON.parse(line)); } catch {} });
      }
      child.stderr?.on('data', chunk => {
        diagnostics.consume(chunk);
        if (failure) failure.native = diagnostics.snapshot();
      });
      child.stderr?.on('end', () => {
        diagnostics.finish();
        if (failure) failure.native = diagnostics.snapshot();
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); child.off('message', ready); error ? reject(error) : resolve(); };
        failStartup = finish;
        const ready = message => { if (message.type === 'ready') finish(); };
        const timer = setTimeout(() => { child.kill(); finish(unavailable('Browser startup timed out')); }, 15000);
        child.on('message', ready); child.once('error', () => finish(unavailable('Browser process could not start')));
        child.once('exit', () => finish(unavailable('Browser process exited during startup')));
      });
    })();
    const attempt = this.starting;
    try {
      await attempt;
      if (!this.ownerConnector && !this.nativeReconciled) {
        await this.commit(draft => { for (const record of draft.pages) record.runtime = { ...record.runtime, kind: 'absent' }; });
        this.nativeReconciled = true;
      }
      return;
    } catch (error) { if (this.starting === attempt) this.starting = null; throw error; }
  }
  receive(message) {
    if (message.type === 'result') {
      const request = this.requests.get(message.id); if (!request) return;
      this.requests.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.value); return;
    }
    const p = [...this.pages.values()].find(page => page.id === message.page);
    if (message.type === 'renderer-gone' && p) {
      this.diagnose('renderer_exited', undefined, message);
      this.resetVisibility(p); p.live = false; p.painted = false; p.controller = null; p.controlToken = null; p.controlKind = null;
      p.controlEpoch = (p.controlEpoch ?? 0) + 1;
      clearTimeout(p.keyTimer); p.keyTimer = null;
      void this.runtimeState(p, 'absent').catch(() => {});
      for (const [id, request] of this.requests) if (request.page === p.id) {
        this.requests.delete(id); clearTimeout(request.timer); request.reject(unavailable('Browser renderer exited; reconnecting'));
      }
      for (const ws of this.viewers(p).keys()) ws.close(1011, 'Browser renderer exited; reconnecting');
      return;
    }
    if (message.type === 'error' && message.message === 'Browser renderer exited; reload this tab') this.diagnose('renderer_exited');
    if (p && !p.recovering && message.type === 'navigation' && !message.state.isLoading) { p.url = checkpointUrl(message.state.url); this.checkpoint(); }
    if (p && message.type === 'viewport') { p.viewport = { width: message.width, height: message.height, deviceProfile: message.deviceProfile }; this.checkpoint(); }
    if (!p) return;
    if (message.type === 'input-reset' && typeof message.document === 'string') p.document = message.document;
    const privateEvent = ['ime-state', 'context-menu', 'new-window'].includes(message.type);
    const packet = message.type === 'frame' ? Buffer.from(message.bytes, 'base64') : null;
    const { page, ...event } = message;
    for (const [ws, viewer] of this.viewers(p)) {
      if (ws.readyState !== WebSocket.OPEN || privateEvent && ws !== p.controller || packet && (!viewer.visible || !viewer.ready)) continue;
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
  request(page, method, input, control, document) {
    if (!this.child || (this.isolated ? this.child.stdin.destroyed : !this.child.connected)) return Promise.reject(unavailable('Browser unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); this.diagnose('request_timeout', method); reject(unavailable(`Browser operation timed out (${method})`)); }, 20000);
      timer.unref(); this.requests.set(id, { page, resolve, reject, timer });
      const failed = error => { if (error) { clearTimeout(timer); this.requests.delete(id); reject(unavailable('Browser disconnected')); } };
      try {
        if (this.isolated) this.child.stdin.write(JSON.stringify({ id, page, method, input, control, document }) + '\n', failed);
        else this.child.send({ id, page, method, input, control, document }, failed);
      } catch (error) { failed(error); }
    });
  }
  upgrade(request, socket, head, { ownerId, authorize = () => {}, track = () => {} }) {
    this.server.handleUpgrade(request, socket, head, ws => {
      this.sockets.add(ws); track(ws);
      let page = null, pending = 0, opening = false;
      const reply = (id, value, error) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id, value,
        ...(error ? { error: { code: error.code || 'BROWSER_ERROR', message: error.message, retryable: !!error.retryable } } : {}) })); };
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
          if (message.method === 'catalog') { reply(message.id, await this.catalog(ownerId, authorize)); return; }
          if (message.method === 'state') {
            const value = await this.metadata(ownerId, message.input, authorize); authorize(); reply(message.id, value); return;
          }
          if (message.method === 'discard') {
            if (!/^[a-zA-Z0-9-]{20,128}$/.test(message.input?.lease ?? '')) throw new Error('Invalid browser lease');
            await this.load(); authorize();
            const key = JSON.stringify([ownerId, message.input.lease]);
            await this.commit(draft => {
              authorize(); if (!draft.retired.includes(key)) draft.retired.push(key);
              const record = draft.pages.find(p => p.key === key);
              if (record) { record.lifecycle = 'closing'; record.closing = true; }
            });
            this.retiredLeases.add(key);
            const target = this.pages.get(key);
            if (target) await this.retire(target);
            reply(message.id); return;
          }
          if (message.method === 'open') {
            if (page || opening) throw new Error('Browser already opened');
            opening = true;
            if (!/^[a-zA-Z0-9-]{20,128}$/.test(message.input?.lease ?? '')) throw new Error('Invalid browser lease');
            const key = JSON.stringify([ownerId, message.input.lease]);
            // Complete an earlier bootstrap before handing its live page to a
            // replacement. Otherwise two create/config/cleanup paths can race.
            const previous = this.attachments.get(key);
            let unlock;
            const attachment = new Promise(resolve => { unlock = resolve; });
            this.attachments.set(key, attachment);
            releaseAttachment = () => { unlock(); if (this.attachments.get(key) === attachment) this.attachments.delete(key); };
            await previous;
            authorize();
            if (this.closed || ws.readyState !== WebSocket.OPEN) return;
            await this.load(); authorize();
            if (this.retiredLeases.has(key)) throw new Error('Browser tab is closed');
            const existing = this.pages.get(key);
            if (existing?.closing) throw new Error('Browser tab is closing');
            const modern = message.input.multiView === true;
            if (!modern && existing && this.viewers(existing).size) {
              if (message.input.takeover !== true || [...this.viewers(existing).values()].some(viewer => viewer.modern)) throw new Error('Browser page already attached; reload OpenCraft for shared viewing');
              for (const old of this.viewers(existing).keys()) { this.detach(existing, old); old.close(4009, 'Browser viewer transferred'); }
            }
            if (existing && this.viewers(existing).size >= 16) throw new Error('Browser viewer limit reached');
            await this.start(); authorize();
            if (this.retiredLeases.has(key)) throw new Error('Browser tab is closed');
            if (ws.readyState !== WebSocket.OPEN) return;
            const unknown = this.store.current.pages.find(p => p.key === key)?.runtime?.kind === 'unknown';
            if (unknown && existing && !existing.live) {
              try { const config = await this.request(existing.id, 'snapshot'); existing.live = true; existing.document = config.document; await this.runtimeState(existing, 'live'); }
              catch (error) {
                if (error.message !== 'Browser page closed') throw error;
                await this.request(existing.id, 'close'); await this.runtimeState(existing, 'absent');
              }
            }
            const reserved = await this.reserve(ownerId, key, message.input, authorize);
            page = existing ?? { ...reserved, controller: null, live: false };
            page.runtime = reserved.runtime;
            if (this.retiredLeases.has(key)) throw sessionError('SESSION_CLOSED', 'Browser tab is closed');
            this.viewers(page).set(ws, { visible: !modern || message.input.visible === true, visibilityEpoch: 0, modern, documentInput: message.input.documentInput === true, inputAcknowledgements: message.input.inputAcknowledgements === true, authorize, ready: false }); this.pages.set(key, page);
            let config;
            const resumed = page.live, recoveryUrl = page.url, recoveryZoom = page.zoom;
            page.recovering = !resumed && !!existing;
            const epoch = page.runtimeEpoch ?? 0, native = this.child;
            const currentNative = () => page && !page.closing && (page.runtimeEpoch ?? 0) === epoch && this.child === native;
            const requireNative = () => { if (!currentNative()) throw unavailable('Browser runtime changed; reconnecting'); };
            try {
              page.creating = resumed && modern ? this.request(page.id, 'snapshot')
                : this.request(page.id, 'create', (modern && existing ? page.viewport : message.input?.viewport) ?? page.viewport
                  ?? { deviceProfile: message.input?.defaultDeviceProfile ?? 'desktop' });
              config = await page.creating; requireNative(); page.live = true;
              if ((!resumed || !page.document) && typeof config.document === 'string') page.document = config.document;
              if (page.closing) throw new Error('Browser tab closed');
              if (!resumed && existing) {
                if (recoveryZoom !== 100) { await this.request(page.id, 'zoom', { percent: recoveryZoom }); requireNative(); }
                if (recoveryUrl) { await this.request(page.id, 'navigate', { url: recoveryUrl }); requireNative(); }
                config = await this.request(page.id, 'snapshot'); requireNative();
                // loadURL has accepted the recovery, but may not have committed
                // its first document yet. Keep the saved remote target as the
                // authority so a viewer's stale initial URL cannot replace it.
                if (recoveryUrl && !checkpointUrl(config.navigation?.url)) {
                  config.navigation = { ...config.navigation, url: recoveryUrl, isLoading: true };
                }
              }
              if (!existing && modern && message.input.initialUrl) {
                await this.visibility(page); requireNative();
                await this.request(page.id, 'navigate', { url: message.input.initialUrl }); requireNative();
                config = await this.request(page.id, 'snapshot'); requireNative();
                if (!checkpointUrl(config.navigation?.url)) config.navigation = { ...config.navigation, url: message.input.initialUrl, isLoading: true };
              }
              page.recovering = false; page.url = checkpointUrl(config.navigation?.url) ?? null;
              page.viewport = { width: config.width, height: config.height, deviceProfile: config.deviceProfile };
              await this.runtimeState(page, 'live', epoch); requireNative(); authorize();
              if (page.closing) throw sessionError('SESSION_CLOSING', 'Browser tab is closing');
              if (ws.readyState !== WebSocket.OPEN) { this.detach(page, ws); return; }
              if (!modern) await this.control(page, ws, { action: 'human', takeover: true }, authorize);
              this.controlChanged(page);
              reply(message.id, { ...config, document: page.document ?? config.document, documentInput: typeof (page.document ?? config.document) === 'string', inputAcknowledgements: message.input.inputAcknowledgements === true, resumed, restored: !!existing && !resumed, multiView: true, initialized: modern && !existing, control: this.controlState(page, ws) });
              const attached = this.viewers(page).get(ws); if (attached) {
                attached.ready = true; this.displayPace(page);
                if (message.input.mediaFeedback === 1) this.display.attach(page, ws, attached, message.input.mediaStage === 'rendered' ? 'rendered' : 'received');
                if (attached.visible) this.keyframe(page);
              }
            } catch (error) {
              page.recovering = false;
              if (page.closing) { page = null; throw error; }
              this.detach(page, ws);
              if (resumed && currentNative()) {
                page.live = false;
                await this.runtimeState(page, error.message === 'Browser page closed' ? 'absent' : 'unknown', epoch);
              }
              if (!resumed && currentNative()) {
                page.live = false; page.url = recoveryUrl;
                await this.runtimeState(page, 'unknown');
                // A native negative ACK is different from transport uncertainty.
                // Never release a timeout reservation based on a timer alone.
                if (error.code !== 'BROWSER_UNAVAILABLE') {
                  try { await this.request(page.id, 'close'); await this.runtimeState(page, 'absent'); }
                  catch { /* unresolved reservation survives restart */ }
                }
              }
              page = null; throw error;
            }
            opening = false; return;
          }
          if (!page || this.pages.get(page.key) !== page || !this.viewers(page).has(ws)) throw new Error('Browser page not opened');
          authorize(); const target = page, viewer = this.viewers(target).get(ws);
          if (message.method === 'mediaFeedback') { this.display.feedback(ws, message.input); return; }
          if (message.method === 'control') { reply(message.id, await this.control(target, ws, message.input, authorize)); return; }
          if (!methods.has(message.method)) throw new Error('Unsupported browser command');
          if (message.method === 'close') {
            await this.retire(target, ws); if (page === target) page = null;
            authorize(); reply(message.id); ws.close(1000, 'Browser tab closed'); return;
          }
          if (target.closing) throw new Error('Browser tab is closing');
          if (message.method === 'visible') {
            viewer.visible = message.input?.visible === true;
            if (!viewer.visible) viewer.visibilityEpoch = (viewer.visibilityEpoch ?? 0) + 1;
            if (!viewer.visible && target.controller === ws && target.controlKind === 'human')
              await this.control(target, ws, { action: 'release', token: target.controlToken }, authorize);
            await this.visibility(target); this.displayPace(target);
            if (viewer.visible) this.keyframe(target);
            return;
          }
          if (message.method === 'keyframe') { this.keyframe(target); return; }
          const readOnly = ['capture', 'copy'].includes(message.method) || message.method === 'automation' && ['inspect', 'readContext', 'wait'].includes(message.input?.method);
          const control = viewer.modern ? message.control : target.controlToken;
          if (!readOnly && (target.controller !== ws || !control || control !== target.controlToken))
            throw Object.assign(new Error('Browser control changed; start a new interaction'), { code: 'CONTROL_LOST', retryable: true });
          const documentBound = ['input', 'text', 'ime'].includes(message.method);
          const document = documentBound ? viewer.documentInput ? message.document : target.document : undefined;
          if (documentBound && viewer.documentInput && (typeof document !== 'string' || document !== target.document))
            throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
          const value = await this.request(target.id, message.method, message.input, readOnly ? undefined : control, document);
          authorize();
          if (page !== target || !this.viewers(target).has(ws) || this.pages.get(target.key) !== target || ws.readyState !== WebSocket.OPEN) return;
          if (message.method === 'zoom') { target.zoom = Number(message.input.percent); await this.persist(); }
          if (['navigate', 'viewport'].includes(message.method)) await this.persist();
          if (!quietMethods.has(message.method) || message.method === 'input' && viewer.inputAcknowledgements) reply(message.id, value);
        } catch (error) { opening = false;
          if (message?.id) reply(message.id, null, error); else ws.close(1008, 'Invalid browser request');
          // Quiet setters have no client waiter. Exhausted display recovery
          // must reattach rather than silently leave this viewer out of sync.
          if (message?.method === 'visible' && error.code === 'BROWSER_UNAVAILABLE')
            ws.close(1013, 'Browser display unavailable; reconnecting');
        }
        finally { releaseAttachment?.(); pending--; }
      });
      ws.on('close', code => {
        this.diagnose('viewer_disconnected', undefined, { closeCode: code });
        this.sockets.delete(ws);
        if (!page) return;
        this.detach(page, ws);
      });
    });
  }
  close() {
    if (this.closed) return;
    if (this.loaded) void this.persist().catch(() => {});
    this.closed = true;
    this.display.close();
    this.diagnose('gateway_shutdown');
    for (const ws of this.sockets) {
      ws.close(1012, 'Browser connection restarting');
      const timer = setTimeout(() => ws.terminate(), 2000); timer.unref();
      ws.once('close', () => clearTimeout(timer));
    }
    clearTimeout(this.checkpointTimer);
    const releasing = Promise.resolve(this.loading).catch(() => {}).then(() => this.store?.tail).then(() => this.releaseWriter?.());
    this.persistence = releasing.catch(() => {});
    for (const page of this.pages.values()) { this.resetVisibility(page); clearTimeout(page.retirementTimer); clearTimeout(page.keyTimer); }
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Browser service closed')); }
    this.requests.clear();
    if (this.isolated) this.child?.stdin.end(); else this.child?.kill();
    this.server.close();
  }
}
