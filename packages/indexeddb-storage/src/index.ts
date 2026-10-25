const HANDOFF_STORE = "__opencraft_identity_handoff";
export class IndexedDbIdentityError extends Error {
  constructor(readonly reason: "blocked" | "timeout", readonly stage: "opening" | "upgrading" = "opening") {
    super(`Database identity migration ${reason}`);
    this.name = "IndexedDbIdentityError";
  }
}
interface Handoff { destination: string; sourceVersion: number; }
interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  keys: IDBValidKey[];
  values: unknown[];
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

/** Never create a missing source/probe database, enumerate names, or retain late handles. */
function openExisting(factory: IDBFactory, name: string, timeout: number): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    let missing = false, settled = false, blocked = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new IndexedDbIdentityError(blocked ? "blocked" : "timeout")), timeout);
    request.addEventListener("upgradeneeded", () => { missing = true; request.transaction?.abort(); });
    request.addEventListener("blocked", () => { blocked = true; });
    request.addEventListener("error", () => {
      if (missing && !settled) { settled = true; clearTimeout(timer); resolve(null); }
      else fail(request.error);
    });
    request.addEventListener("success", () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    });
  });
}

/**
 * Copy a known versioned owner's database once, before its normal open.
 * The destination is authoritative if present. Upgrade the source to retire
 * its fixed-version writers before taking a snapshot; old windows may release
 * their handles within the deadline. Persisting blockers fail explicitly.
 * All rows/schema are copied in the destination creation transaction.
 * The historical source remains intact for retry or deliberate recovery.
 */
export async function migrateIndexedDbIdentity(options: {
  factory: IDBFactory;
  name: string;
  formerName: string;
  formerWriterVersion: number;
  timeoutMs?: number;
}): Promise<void> {
  const { factory, name, formerName, formerWriterVersion } = options;
  const timeout = options.timeoutMs ?? 10_000;
  if (name === formerName) throw new Error("Database identity migration requires distinct names");
  const current = await openExisting(factory, name, timeout);
  if (current) { current.close(); return; }
  let source = await openExisting(factory, formerName, timeout);
  if (!source) return;
  let handoff: Handoff;
  try {
    if (source.objectStoreNames.contains(HANDOFF_STORE)) {
      handoff = await result(source.transaction(HANDOFF_STORE).objectStore(HANDOFF_STORE).get("target"));
      if (!handoff || handoff.destination !== name || !Number.isInteger(handoff.sourceVersion)
        || handoff.sourceVersion < 1 || handoff.sourceVersion > formerWriterVersion) throw new Error("Unknown database identity handoff");
    } else {
      if (source.version > formerWriterVersion) throw new Error("Unknown former database version");
      handoff = { destination: name, sourceVersion: source.version };
      source.close(); source = null;
      source = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(formerName, formerWriterVersion + 1);
        let settled = false, blocked = false;
        const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => fail(new IndexedDbIdentityError(blocked ? "blocked" : "timeout", "upgrading")), timeout);
        request.onblocked = () => { blocked = true; };
        request.onupgradeneeded = () => {
          if (settled) { request.transaction?.abort(); return; }
          request.result.createObjectStore(HANDOFF_STORE).put(handoff, "target");
        };
        request.onerror = () => fail(request.error);
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true; clearTimeout(timer);
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
      });
      const actual = await result<Handoff>(source.transaction(HANDOFF_STORE).objectStore(HANDOFF_STORE).get("target"));
      if (actual.destination !== name) throw new Error("Conflicting database identity handoff");
      handoff = actual;
    }
    const names = Array.from(source.objectStoreNames).filter(store => store !== HANDOFF_STORE);
    const snapshots: StoreSnapshot[] = [];
    if (names.length) {
      const transaction = source.transaction(names, "readonly");
      const completion = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Database identity snapshot failed"));
      });
      const reads = names.map(async name => {
        const store = transaction.objectStore(name);
        if (store.autoIncrement) throw new Error("Unsupported auto-increment identity source");
        const indexes = Array.from(store.indexNames).map(name => {
          const index = store.index(name);
          return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        });
        const [keys, values] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
        return { name, keyPath: store.keyPath, indexes, keys, values };
      });
      const [rows] = await Promise.all([Promise.all(reads), completion]); snapshots.push(...rows);
    }
    source.close(); source = null;
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(name, handoff.sourceVersion);
      let settled = false, existing = false, blocked = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { request.transaction?.abort(); fail(new IndexedDbIdentityError(blocked ? "blocked" : "timeout", "upgrading")); }, timeout);
      request.onblocked = () => { blocked = true; };
      request.onupgradeneeded = event => {
        if (settled) { request.transaction?.abort(); return; }
        // Another current client may have won the creation race. Never merge its data.
        if (event.oldVersion !== 0) { existing = true; request.transaction?.abort(); return; }
        try {
          for (const snapshot of snapshots) {
            const store = request.result.createObjectStore(snapshot.name, { keyPath: snapshot.keyPath });
            for (const index of snapshot.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
            snapshot.values.forEach((value, index) => {
              if (snapshot.keyPath === null) store.add(value, snapshot.keys[index]); else store.add(value);
            });
          }
        } catch (error) { request.transaction?.abort(); fail(error); }
      };
      request.onerror = () => {
        if (existing && !settled) { settled = true; clearTimeout(timer); resolve(); }
        else fail(request.error);
      };
      request.onsuccess = () => {
        request.result.close();
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      };
    });
  } finally { source?.close(); }
}
