import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserOwnerEvents } from './browser-owner-events.mjs';
import { BrowserStateFile, acquireBrowserStateWriter, sessionError } from './remote-browser-state-file.mjs';
import { startBrowserOwner, prepareBrowserOwnerConnector, stopEmptyBrowserOwner } from './remote-browser-owner.mjs';
import { browserRuntimeIdentity } from './browser-runtime-identity.mjs';

// The compatible allocation-disabled reader/writer is the rollback floor.
const allocateGenerationsByDefault = true;
const MAX_SLOTS = 3, MAX_JOBS = 1024, MAX_BYTES = 4 * 1024 * 1024;
const ordered = new Set(['create', 'input', 'text', 'ime', 'copy', 'viewport', 'visible', 'zoom', 'close', 'control']);
const unavailable = () => sessionError('BROWSER_UNAVAILABLE', 'Browser unavailable; reconnecting', true);
const validSlot = id => id === 'legacy' || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

function validate(saved) {
  if (saved?.schemaVersion !== 1 || !Array.isArray(saved.slots) || !saved.slots.length || saved.slots.length > MAX_SLOTS
    || saved.slots.some(id => typeof id !== 'string' || !validSlot(id)) || new Set(saved.slots).size !== saved.slots.length
    || !saved.slots.includes(saved.currentSlot) || !Array.isArray(saved.placements) || saved.placements.length > 4096)
    throw new Error('Unsupported browser owner placements');
  const seen = new Set();
  for (const entry of saved.placements) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(entry[0])
      || !saved.slots.includes(entry[1]) || seen.has(entry[0])) throw new Error('Invalid browser owner placement');
    seen.add(entry[0]);
  }
  return saved;
}

/** Physical placement only. Logical authorization, quotas and retirement remain
 * exclusively in RemoteBrowserService. No input is replayed after uncertainty. */
export async function startBrowserOwnerPool({ directory, dataDirectory,
  allocateGenerations = allocateGenerationsByDefault, connector, stop = stopEmptyBrowserOwner }) {
  let saved;
  try { saved = validate(JSON.parse(await readFile(join(dataDirectory, 'owner-pool.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!saved && !allocateGenerations) return (connector ?? startBrowserOwner)({ directory, dataDirectory });
  if (!connector) connector = await prepareBrowserOwnerConnector(directory);
  else {
    await Promise.all([access(join(directory, 'worker.cjs')), access(join(directory, 'owner.cjs')),
      access(join(directory, 'electron/electron'), constants.X_OK)]);
    await browserRuntimeIdentity(directory); // Injected private connectors also validate candidates.
  }
  const writerDirectory = join(dataDirectory, 'owner-pool-writer');
  await mkdir(writerDirectory, { recursive: true, mode: 0o700 });
  const releaseWriter = await acquireBrowserStateWriter(writerDirectory);
  // Read again under the lease: a predecessor may have committed between the
  // initial presence probe and acquiring this writer identity.
  try { saved = validate(JSON.parse(await readFile(join(dataDirectory, 'owner-pool.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') { await releaseWriter(); throw error; } saved = undefined; }
  const store = new BrowserStateFile(dataDirectory, saved ?? { schemaVersion: 1, slots: ['legacy'], currentSlot: 'legacy', placements: [] }, 'owner-pool.json');
  const pool = new BrowserOwnerEvents(), slots = new Map(), tasks = new Set(), detachments = new Set();
  let detachError;
  let metadataTail = Promise.resolve(), stopped = false, totalJobs = 0, totalBytes = 0;
  pool.connected = true;
  const slotDirectory = id => id === 'legacy' ? dataDirectory : join(dataDirectory, 'owners', id);
  const placement = page => store.current.placements.find(([id]) => id === page)?.[1];
  const pagesFor = slot => store.current.placements.filter(([, id]) => id === slot.id).map(([page]) => page);
  const serial = work => {
    const operation = metadataTail.then(() => { if (stopped) throw unavailable(); return work(); });
    metadataTail = operation.catch(() => {}); return operation;
  };
  function detachPeer(slot, peer) {
    if (!peer) return slot.detaching;
    let closing;
    try { closing = Promise.resolve(peer.kill()); }
    catch (error) { closing = Promise.reject(error); }
    // kill() initiates socket destruction; its returned completion owns the
    // physical detach. Retain only in-flight work, including failed peers that
    // no longer appear in slot.peer and late results of an attachment.
    const draining = Promise.all([slot.detaching, closing]).then(() => {});
    slot.detaching = draining; detachments.add(draining);
    void draining.then(() => detachments.delete(draining), error => {
      detachError ??= error; detachments.delete(draining);
    });
    return draining;
  }
  function failSlot(slot, native) {
    const peer = slot.peer; slot.peer = null;
    if (!peer) return;
    slot.epoch = (slot.epoch ?? 0) + 1;
    detachPeer(slot, peer);
    for (const job of [...slot.pending.values(), ...slot.queue]) { clearTimeout(job.timer); job.reject(unavailable()); }
    slot.pending.clear(); slot.queue = []; slot.writes = slot.reads = 0;
    if (!stopped && !slot.retiring) pool.publish('owner-slot-failure', { pages: pagesFor(slot), ...(native === undefined ? {} : { native }) });
  }
  function pump(slot) {
    if (!slot.peer?.connected || stopped) return;
    // Reads cannot occupy the edit window: a long automation wait must still
    // observe later user input. Both budgets stay below native's 128-RPC cap.
    for (let index = 0; index < slot.queue.length;) {
      const job = slot.queue[index], key = job.ordered ? 'writes' : 'reads', limit = job.ordered ? 64 : 16;
      if (slot[key] >= limit) { index++; continue; }
      slot.queue.splice(index, 1); slot[key]++; slot.pending.set(job.id, job);
      try { slot.peer.send({ ...job.message, id: job.id }, error => { if (error) failSlot(slot); }); }
      catch { failSlot(slot); return; }
    }
  }
  async function connectSlot(id) {
    let slot = slots.get(id);
    if (!slot) { slot = { id, peer: null, queue: [], pending: new Map(), reads: 0, writes: 0 }; slots.set(id, slot); }
    if (slot.peer?.connected) return slot;
    if (slot.connecting) return slot.connecting;
    slot.connecting = (async () => {
      await slot.detaching;
      if (stopped) throw unavailable();
      const peer = await connector({ directory, dataDirectory: slotDirectory(id) });
      if (stopped) { await detachPeer(slot, peer); throw unavailable(); }
      slot.peer = peer;
      peer.on('error', () => { if (slot.peer === peer) failSlot(slot); });
      peer.on('exit', () => { if (slot.peer === peer) failSlot(slot); });
      peer.on('message', message => {
        if (slot.peer !== peer || stopped) return;
        if (message.type === 'result') {
          const job = slot.pending.get(message.id); if (!job) return;
          clearTimeout(job.timer); slot.pending.delete(message.id); slot[job.ordered ? 'writes' : 'reads']--;
          message.error ? job.reject(Object.assign(new Error(message.error.message), message.error)) : job.resolve(message.value);
          pump(slot);
        } else if (message.type === 'owner-failure') failSlot(slot, message.native);
        else pool.publish('message', message);
      });
      // A result/event failure may have arrived in the attach packet.
      await Promise.resolve();
      if (slot.peer !== peer || !peer.connected) throw unavailable();
      return slot;
    })().finally(() => { slot.connecting = null; });
    return slot.connecting;
  }
  async function rpc(slot, message) {
    if (stopped || !slot.peer?.connected) throw unavailable();
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), message, ordered: ordered.has(message.method) || message.control !== undefined, resolve, reject };
      job.timer = setTimeout(() => failSlot(slot), 19000); job.timer.unref();
      slot.queue.push(job); pump(slot);
    });
  }
  async function inventory(slot) {
    const values = await rpc(slot, { method: 'inventory' });
    if (!Array.isArray(values)) { failSlot(slot); throw unavailable(); }
    return values;
  }
  async function reconcile(slot, values) {
    for (const config of values) {
      if (typeof config?.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(config.id)) throw new Error('Invalid native browser inventory');
      const current = placement(config.id);
      if (current && current !== slot.id) throw new Error('Conflicting native browser placement');
    }
    await store.transact(draft => {
      for (const config of values) if (!draft.placements.some(([id]) => id === config.id)) draft.placements.push([config.id, slot.id]);
      validate(draft);
    });
  }
  async function collectEmpty() {
    for (const id of [...store.current.slots]) {
      if (id === store.current.currentSlot) continue;
      const slot = slots.get(id);
      if (!slot?.peer?.connected || pagesFor(slot).length || slot.queue.length || slot.pending.size) continue;
      if ((await inventory(slot)).length) continue;
      slot.retiring = true;
      try {
        await stop(slotDirectory(id));
        const peer = slot.peer; slot.peer = null;
        await detachPeer(slot, peer); slots.delete(id);
        await store.transact(draft => { draft.slots = draft.slots.filter(value => value !== id); });
      } finally { slot.retiring = false; }
    }
  }
  async function currentSlot() {
    let slot = await connectSlot(store.current.currentSlot);
    if (slot.peer.runtimeCurrent || !allocateGenerations) return slot;
    // Find an already-current owner before allocating another profile.
    for (const id of store.current.slots) {
      const candidate = slots.get(id);
      if (candidate?.peer?.connected && candidate.peer.runtimeCurrent) {
        await store.transact(draft => { draft.currentSlot = id; }); return candidate;
      }
    }
    await collectEmpty();
    if (store.current.slots.length >= MAX_SLOTS)
      throw sessionError('BROWSER_UNAVAILABLE', 'Close older browser tabs before opening a new browser version', true);
    const id = randomUUID();
    // Durable slot identity precedes its managed process, even if attach fails.
    await store.transact(draft => { draft.slots.push(id); draft.currentSlot = id; });
    slot = await connectSlot(id);
    return slot;
  }
  async function dispatch(message) {
    if (message.method === 'inventory') {
      const values = await Promise.all(store.current.slots.map(async id => inventory(await connectSlot(id))));
      return values.flat();
    }
    let id = placement(message.page);
    if (!id && message.method === 'create') {
      id = await serial(async () => {
        const existing = placement(message.page); if (existing) return existing;
        if (typeof message.page !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(message.page)) throw new Error('Invalid browser page');
        const slot = await currentSlot();
        await store.transact(draft => { draft.placements.push([message.page, slot.id]); validate(draft); });
        return slot.id;
      });
    }
    if (!id) { if (message.method === 'close') return; throw unavailable(); }
    const previous = slots.get(id), epoch = previous?.epoch ?? 0;
    const slot = await connectSlot(id);
    if ((slot.epoch ?? 0) !== epoch) throw unavailable();
    return rpc(slot, message);
  }
  pool.send = (message, callback) => {
    if (stopped) { callback?.(unavailable()); return; }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (totalJobs >= MAX_JOBS || totalBytes + bytes > MAX_BYTES) {
      const slot = slots.get(placement(message.page));
      if (slot) failSlot(slot);
      callback?.(unavailable()); return;
    }
    totalJobs++; totalBytes += bytes;
    const task = dispatch(message).then(value => { if (!stopped) pool.publish('message', { type: 'result', id: message.id, value }); },
      error => { if (!stopped) pool.publish('message', { type: 'result', id: message.id,
        error: { code: error.code ?? 'BROWSER_UNAVAILABLE', message: error.message, retryable: error.retryable !== false } }); })
      .finally(() => { totalJobs--; totalBytes -= bytes; tasks.delete(task); });
    tasks.add(task); callback?.(null);
  };
  pool.releasePage = page => serial(async () => {
    const id = placement(page); if (!id) return;
    const slot = await connectSlot(id);
    // Only explicit logical retirement may remove a placement. Recovery's
    // native close retains it, so a missing page is recreated in its own slot.
    if ((await inventory(slot)).some(config => config.id === page)) throw unavailable();
    await store.transact(draft => { draft.placements = draft.placements.filter(([id]) => id !== page); });
    await collectEmpty();
  });
  pool.kill = () => {
    if (stopped) return pool.closed;
    stopped = true; pool.connected = false;
    for (const slot of slots.values()) failSlot(slot);
    pool.early = []; pool.earlyBytes = 0;
    pool.closed = Promise.allSettled([...tasks, metadataTail]).then(() => store.tail).then(async () => {
      await Promise.all([...detachments]);
      if (detachError) throw detachError;
      await releaseWriter();
    });
    pool.publish('exit');
    return pool.closed;
  };
  try {
    const values = []; pool.unavailablePages = new Set();
    for (const id of store.current.slots) {
      let slot;
      try { slot = await connectSlot(id); }
      catch (error) {
        // Before initial legacy adoption an unreachable inventory is unknown
        // for every logical page. Do not publish an empty migration snapshot.
        if (!saved) throw error;
        for (const [page, slotId] of store.current.placements) if (slotId === id) pool.unavailablePages.add(page);
        continue;
      }
      const native = slot.peer.inventory;
      await reconcile(slot, native); values.push(...native);
    }
    // The reader does not allocate until an actual new-page admission.
    pool.inventory = values;
    Object.defineProperties(pool, {
      workerPid: { get: () => slots.get(store.current.currentSlot)?.peer?.workerPid },
      runtimeCurrent: { get: () => slots.get(store.current.currentSlot)?.peer?.runtimeCurrent ?? false },
    });
    return pool;
  } catch (error) { await pool.kill(); throw error; }
}
