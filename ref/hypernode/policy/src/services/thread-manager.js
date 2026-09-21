import { Service } from "@deepseek-ai/cordis";
import { HYPERNODE_ROUTER_PROVIDER_ID } from "./model-router.ts";
import {
  CLOUD_THREAD_PREFIX,
  canonicalThreadTitle,
  cloudThreadName,
  uuidV7,
} from "./thread-identity.ts";
export {
  canonicalThreadTitle,
  cloudThreadName,
  uuidV7,
} from "./thread-identity.ts";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

const ITEMS_VIEW_RANK = new Map([
  ["notLoaded", 0],
  ["summary", 1],
  ["full", 2],
]);

export function isTerminalTurnStatus(status) {
  return TERMINAL_TURN_STATUSES.has(status);
}

function itemFidelity(turn) {
  return [
    ITEMS_VIEW_RANK.get(turn?.itemsView) ?? (Array.isArray(turn?.items) && turn.items.length > 0 ? 1 : 0),
    Array.isArray(turn?.items) ? turn.items.length : 0,
  ];
}

function compareItemFidelity(left, right) {
  const [leftView, leftCount] = itemFidelity(left);
  const [rightView, rightCount] = itemFidelity(right);
  return leftView - rightView || leftCount - rightCount;
}

function projectedItemSemanticKey(item) {
  if (item?.type === "agentMessage" && typeof item.text === "string") {
    return `agentMessage\u0000${item.text}`;
  }
  if (item?.type === "userMessage" && Array.isArray(item.content)) {
    return `userMessage\u0000${JSON.stringify(item.content)}`;
  }
  return null;
}

function mergeProjectedItems(current = [], incoming = [], preferIncoming = false) {
  const preferred = preferIncoming ? incoming : current;
  const supplemental = preferIncoming ? current : incoming;
  const supplementalById = new Map(supplemental.filter((item) => item?.id).map((item) => [item.id, item]));
  const seen = new Set();
  const seenSemantics = new Set();
  const merged = preferred.map((item) => {
    if (!item?.id) return item;
    seen.add(item.id);
    const semantic = projectedItemSemanticKey(item);
    if (semantic) seenSemantics.add(semantic);
    const other = supplementalById.get(item.id);
    return other == null ? item : { ...other, ...item };
  });
  for (const item of supplemental) {
    const semantic = projectedItemSemanticKey(item);
    if ((!item?.id || !seen.has(item.id)) && (!semantic || !seenSemantics.has(semantic))) merged.push(item);
  }
  return merged;
}

export function mergeProjectedTurn(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;

  const currentIsTerminal = isTerminalTurnStatus(current.status);
  const incomingIsTerminal = isTerminalTurnStatus(incoming.status);
  if (currentIsTerminal && !incomingIsTerminal) return current;
  if (currentIsTerminal && incomingIsTerminal) {
    // Keep the first terminal outcome, but let authoritative history enrich
    // the item payload. Completion notifications commonly contain only the
    // final assistant item while a later history page also contains the user
    // and tool items.
    const preferIncoming = compareItemFidelity(incoming, current) > 0;
    if (!preferIncoming) return current;
    const richer = preferIncoming ? incoming : current;
    return {
      ...incoming,
      ...current,
      items: mergeProjectedItems(current.items, incoming.items, preferIncoming),
      itemsView: richer.itemsView ?? current.itemsView ?? incoming.itemsView,
    };
  }
  return { ...current, ...incoming };
}

export function mergeProjectedTurns(currentTurns = [], incomingTurns = []) {
  const incomingById = new Map(incomingTurns.filter((turn) => turn?.id).map((turn) => [turn.id, turn]));
  const currentIds = new Set();
  const merged = currentTurns.filter((turn) => turn?.id).map((current) => {
    currentIds.add(current.id);
    return mergeProjectedTurn(current, incomingById.get(current.id));
  });
  for (const incoming of incomingTurns) {
    if (incoming?.id && !currentIds.has(incoming.id)) merged.push(incoming);
  }
  return merged;
}

function normalizeThreadName(thread) {
  const name = cloudThreadName(thread.name, thread.preview);
  if (thread.name === name) return false;
  thread.name = name;
  return true;
}

function cursorFingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function encodeThreadCursor(signature, sortField, thread, sortValue = thread[sortField] ?? 0) {
  return encodeURIComponent(JSON.stringify({
    version: 1,
    signature,
    sortField,
    value: Number(sortValue),
    id: String(thread.id),
  }));
}

function decodeThreadCursor(value, signature, sortField) {
  if (typeof value !== "string" || !value) return null;
  let cursor;
  try {
    cursor = JSON.parse(decodeURIComponent(value));
  } catch {
    throw new Error("invalid thread/list cursor");
  }
  if (cursor?.version !== 1 || cursor.signature !== signature || cursor.sortField !== sortField ||
      !Number.isFinite(cursor.value) || typeof cursor.id !== "string") {
    throw new Error("thread/list cursor does not match this query");
  }
  return cursor;
}

export class ThreadManagerService extends Service {
  constructor(ctx) {
    super(ctx, "threadManager");
    this.principal = ctx.principal.current();
    this.titleService = null;
    this.threads = new Map();
    this.archivedThreadIds = new Set();
    this.metadata = new Map();
    this.sectionPositions = new Map();
    this.archiveListeners = new Set();
    this.unarchiveListeners = new Set();
    this.createListeners = new Set();
    this.archiveGuards = new Set();
    this.catalogRevision = 0;
    this.catalogCache = new Map();
    this.persistedRecords = new Map();
    this.persistedCatalogMeta = null;
    this.initializeStorage();
    this.load();
  }

  initializeStorage() {
    // Minimal/embedded policy hosts used by tests and recovery tools may not
    // expose SQLite. Preserve the pre-SQL policyStore backend in that case;
    // persist() and load() already implement the same fallback.
    if (!this.ctx?.storage?.sql) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_thread_catalog_records (
        principal_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (principal_id, thread_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_thread_catalog_meta (
        principal_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
  }

  invalidateCatalog() {
    this.catalogRevision = (this.catalogRevision ?? 0) + 1;
    this.catalogCache ??= new Map();
    this.catalogCache.clear();
  }

  load() {
    this.sectionPositions ??= new Map();
    const sqlMetaRow = this.ctx?.storage?.sql ? this.ctx.storage.sql.exec(`
      SELECT payload FROM do_thread_catalog_meta WHERE principal_id = ?
    `, this.principal.id).toArray()[0] : null;
    const sqlRecords = sqlMetaRow ? this.ctx.storage.sql.exec(`
      SELECT thread_id, payload
      FROM do_thread_catalog_records
      WHERE principal_id = ?
    `, this.principal.id).toArray() : [];
    if (sqlMetaRow) {
      let changed = false;
      for (const row of sqlRecords) {
        const record = JSON.parse(row.payload);
        changed = this.loadRecord(record, 4) || changed;
        this.persistedRecords.set(row.thread_id, row.payload);
      }
      const meta = JSON.parse(sqlMetaRow.payload);
      for (const [threadId, position] of meta.sectionPositions ?? []) {
        if (this.threads.has(threadId) && Number.isFinite(position)) this.sectionPositions.set(threadId, position);
      }
      this.persistedCatalogMeta = sqlMetaRow.payload;
      if (changed) this.persist();
      return;
    }
    const encoded = policyStore.get("threadCatalog", this.principal.id);
    if (encoded == null) return;
    const snapshot = JSON.parse(encoded);
    if (![1, 2, 3, 4].includes(snapshot.version) || !Array.isArray(snapshot.records)) {
      throw new Error("unsupported persisted thread catalog");
    }
    let changed = false;
    for (const record of snapshot.records) {
      if (!record.ownerPrincipalId || !record.thread?.id) continue;
      // Ephemeral helper threads are connection-scoped. Older builds accidentally
      // persisted them, so dropping them while loading also performs the migration.
      if (record.thread.ephemeral === true) {
        changed = true;
        continue;
      }
      // Versions <= 2 implemented thread/list(sectionId) by mutating every
      // returned thread into the requested section. Hypernode had no genuine
      // section-assignment command at the time, so every persisted section in
      // those snapshots is projection pollution and must be removed once.
      if (snapshot.version <= 2 && record.thread.section != null) {
        record.thread.section = null;
        record.thread.sectionEnteredAt = null;
        changed = true;
      }
      const normalized = this.loadRecord(record, snapshot.version);
      changed = normalized || changed;
    }
    for (const [threadId, position] of snapshot.sectionPositions ?? []) {
      if (this.threads.has(threadId) && Number.isFinite(position)) this.sectionPositions.set(threadId, position);
    }
    if (snapshot.version < 4) {
      const sectionMembers = new Map();
      for (const thread of this.threads.values()) {
        if (thread.section?.id == null) continue;
        const members = sectionMembers.get(thread.section.id) ?? [];
        members.push(thread);
        sectionMembers.set(thread.section.id, members);
      }
      for (const members of sectionMembers.values()) {
        members.sort((left, right) => (left.sectionEnteredAt ?? 0) - (right.sectionEnteredAt ?? 0) ||
          String(left.id).localeCompare(String(right.id)));
        members.forEach((thread, index) => this.sectionPositions.set(thread.id, (index + 1) * 1_000_000));
      }
      changed = true;
    }
    // The legacy single-value KV is only a migration source. SQL rows become
    // authoritative before any richer history is projected.
    this.persist();
  }

  loadRecord(record, version) {
    // The catalog owns metadata only. Conversation history is rebuilt from
    // CanonicalTimelineService and engine-native ledgers, never from a nested
    // transcript snapshot that happened to be present in an older catalog.
    record.thread = { ...record.thread, turns: [] };
    let changed = normalizeThreadName(record.thread);
    let kind = record.kind ?? (record.root === true ? "management" : "conversation");
    if (kind === "conversation" &&
        (record.thread.cwd === "/localhost" || record.thread.cwd?.startsWith("/localhost/"))) {
      kind = "transparentCodex";
      changed = true;
    }
    this.threads.set(record.thread.id, record.thread);
    this.metadata.set(record.thread.id, {
      ownerPrincipalId: record.ownerPrincipalId,
      visibility: record.visibility ?? "private",
      kind,
      ...(record.executionFacade ? { executionFacade: record.executionFacade } : {}),
      ...(record.workspaceSourceThreadId ? { workspaceSourceThreadId: record.workspaceSourceThreadId } : {}),
    });
    if (record.archived === true) this.archivedThreadIds.add(record.thread.id);
    return changed;
  }

  persistableRecord(thread) {
    return {
      thread: {
        ...thread,
        turns: undefined,
        // The catalog retains a raw compatibility copy. ThreadTitleService is
        // authoritative once attached, and runtime projection restores badges.
        name: canonicalThreadTitle(thread.name, thread.preview),
      },
      ...this.metadata.get(thread.id),
      archived: this.archivedThreadIds.has(thread.id),
    };
  }

  // Hot Turn updates only mutate one catalog record. Re-encoding the complete
  // catalog on every input made the shared management Thread scale with the
  // total number of Threads, even though SQL already stores one row per Thread.
  persistThread(threadId) {
    const thread = this.get(threadId);
    this.invalidateCatalog();
    if (thread.ephemeral === true) return;
    if (!this.ctx?.storage?.sql) {
      this.persist();
      return;
    }
    const payload = JSON.stringify(this.persistableRecord(thread));
    if (this.persistedRecords.get(threadId) === payload) return;
    this.ctx.storage.sql.exec(`
      INSERT INTO do_thread_catalog_records(principal_id, thread_id, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(principal_id, thread_id) DO UPDATE SET payload = excluded.payload
    `, this.principal.id, threadId, payload);
    this.persistedRecords.set(threadId, payload);
  }

  persist() {
    this.sectionPositions ??= new Map();
    this.invalidateCatalog();
    if (!this.ctx?.storage?.sql) {
      const legacyRecords = [...this.threads.values()]
        .filter((thread) => thread.ephemeral !== true)
        .map((thread) => this.persistableRecord(thread));
      policyStore.set("threadCatalog", this.principal.id, JSON.stringify({
        version: 4,
        records: legacyRecords,
        sectionPositions: [...this.sectionPositions.entries()],
      }));
      return;
    }
    const records = [...this.threads.values()]
      .filter((thread) => thread.ephemeral !== true)
      .map((thread) => this.persistableRecord(thread));
    const recordIds = new Set(records.map((record) => record.thread.id));
    // Catalog writes are metadata-only. CanonicalTimelineService owns durable
    // history; the old transcript table is read solely by the offline importer.
    {
      for (const record of records) {
        const threadId = record.thread.id;
        const payload = JSON.stringify(record);
        if (this.persistedRecords.get(threadId) !== payload) {
          this.ctx.storage.sql.exec(`
            INSERT INTO do_thread_catalog_records(principal_id, thread_id, payload)
            VALUES (?, ?, ?)
            ON CONFLICT(principal_id, thread_id) DO UPDATE SET payload = excluded.payload
          `, this.principal.id, threadId, payload);
          this.persistedRecords.set(threadId, payload);
        }
      }
      for (const threadId of [...this.persistedRecords.keys()]) {
        if (recordIds.has(threadId)) continue;
        this.ctx.storage.sql.exec(`
          DELETE FROM do_thread_catalog_records WHERE principal_id = ? AND thread_id = ?
        `, this.principal.id, threadId);
        this.persistedRecords.delete(threadId);
      }
      const metaPayload = JSON.stringify({
        version: 1,
        sectionPositions: [...this.sectionPositions.entries()],
      });
      if (this.persistedCatalogMeta !== metaPayload) {
        this.ctx.storage.sql.exec(`
          INSERT INTO do_thread_catalog_meta(principal_id, payload) VALUES (?, ?)
          ON CONFLICT(principal_id) DO UPDATE SET payload = excluded.payload
        `, this.principal.id, metaPayload);
        this.persistedCatalogMeta = metaPayload;
      }
    }
  }

  create(params = {}, overrides = {}, metadata = {}) {
    const now = Math.floor(Date.now() / 1000);
    const id = overrides.id ?? uuidV7();
    const thread = {
      id,
      sessionId: id,
      name: cloudThreadName(overrides.name, overrides.preview),
      preview: overrides.preview ?? "",
      cwd: params.cwd ?? "/workspace",
      cliVersion: "0.148.0-alpha.21",
      modelProvider: params.modelProvider ?? "openai",
      source: "appServer",
      threadSource: params.threadSource ?? "user",
      status: overrides.status ?? { type: "idle" },
      createdAt: now,
      updatedAt: now,
      recencyAt: now,
      ephemeral: params.ephemeral === true,
      projectId: typeof params.projectId === "string" && params.projectId ? params.projectId : null,
      parentThreadId: null,
      forkedFromId: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      path: null,
      section: null,
      sectionEnteredAt: null,
      turns: [],
    };
    this.threads.set(id, thread);
    this.metadata.set(id, {
      ownerPrincipalId: metadata.ownerPrincipalId ?? this.principal.id,
      visibility: metadata.visibility ?? "private",
      kind: metadata.kind ?? "conversation",
      ...(metadata.workspaceSourceThreadId ? { workspaceSourceThreadId: metadata.workspaceSourceThreadId } : {}),
    });
    this.titleService?.ensure(thread, overrides.name, {
      source: "create",
      actor: metadata.actor,
    });
    try {
      for (const listener of this.createListeners ?? []) {
        listener(thread, this.metadataFor(thread.id));
      }
      if (!thread.ephemeral) this.persist();
      else this.invalidateCatalog();
    } catch (error) {
      this.threads.delete(id);
      this.metadata.delete(id);
      this.titleService?.remove(id);
      if (!thread.ephemeral) this.persist();
      else this.invalidateCatalog();
      throw error;
    }
    return thread;
  }

  onCreate(listener) {
    this.createListeners ??= new Set();
    this.createListeners.add(listener);
    return () => this.createListeners.delete(listener);
  }

  addArchiveGuard(guard) {
    this.archiveGuards ??= new Set();
    this.archiveGuards.add(guard);
    return () => this.archiveGuards.delete(guard);
  }

  find(threadId) {
    return this.threads.get(threadId) ?? null;
  }

  get(threadId) {
    const thread = this.find(threadId);
    if (!thread) throw new Error(`unknown mock thread: ${threadId}`);
    return thread;
  }

  ensure(threadId, params = {}, metadata = {}) {
    return this.find(threadId) ?? this.create(params, { id: threadId }, metadata);
  }

  visibleTo(threadId, actorPrincipalId) {
    const metadata = this.metadata.get(threadId);
    if (!metadata) return false;
    return metadata.visibility !== "private" ||
      (typeof actorPrincipalId === "string" && metadata.ownerPrincipalId === actorPrincipalId);
  }

  setVisibility(threadId, visibility) {
    if (visibility !== "private" && visibility !== "nodeShared") {
      throw new TypeError(`unsupported thread visibility: ${visibility}`);
    }
    const thread = this.get(threadId);
    const metadata = this.metadata.get(threadId);
    if (!metadata) throw new Error(`unknown mock thread: ${threadId}`);
    if (this.isSystem(threadId) && visibility !== "nodeShared") {
      throw new Error("system threads cannot be private");
    }
    if (metadata.visibility === visibility) return thread;
    metadata.visibility = visibility;
    this.persistThread(threadId);
    return thread;
  }

  list(params = {}, actorPrincipalId = undefined) {
    const wantsArchived = params.archived === true;
    let threads = [...this.threads.values()].filter((thread) => {
      const metadata = this.metadata.get(thread.id);
      return metadata != null && thread.ephemeral !== true &&
        (actorPrincipalId === undefined || this.visibleTo(thread.id, actorPrincipalId)) &&
        this.archivedThreadIds.has(thread.id) === wantsArchived;
    });
    if (Object.prototype.hasOwnProperty.call(params, "sectionId")) {
      threads = threads.filter((thread) => params.sectionId == null
        ? thread.section == null
        : thread.section?.id === params.sectionId);
    }
    if (Object.prototype.hasOwnProperty.call(params, "projectId")) {
      threads = threads.filter((thread) => (thread.projectId ?? null) === (params.projectId ?? null));
    }
    if (params.cwd != null) {
      const requested = new Set((Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map(String));
      threads = threads.filter((thread) => requested.has(thread.cwd));
    }
    if (typeof params.searchTerm === "string" && params.searchTerm.trim()) {
      const query = params.searchTerm.trim().toLocaleLowerCase();
      threads = threads.filter((thread) => `${thread.name ?? ""}\n${thread.preview ?? ""}`.toLocaleLowerCase().includes(query));
    }
    if (Array.isArray(params.modelProviders) && params.modelProviders.length > 0) {
      const providers = new Set(params.modelProviders);
      // hypernode-router is an outer protocol facade, not the provider stored
      // in a rollout.  Treat it as the complete HyperNode catalog rather than
      // filtering durable Threads by their private execution identity.
      if (!providers.has(HYPERNODE_ROUTER_PROVIDER_ID)) {
        threads = threads.filter((thread) => providers.has(thread.modelProvider));
      }
    }
    if (Array.isArray(params.sourceKinds) && params.sourceKinds.length > 0) {
      const sourceKinds = new Set(params.sourceKinds);
      threads = threads.filter((thread) => sourceKinds.has(
        typeof thread.source === "string" ? thread.source : thread.source?.kind ?? "unknown",
      ));
    }
    const sortField = params.sortKey === "created_at" || params.sortKey === "createdAt" ? "createdAt"
      : params.sortKey === "updated_at" || params.sortKey === "updatedAt" ? "updatedAt"
        : params.sortKey === "section_position" ? "sectionPosition" : "recencyAt";
    const direction = params.sortDirection === "asc" ? 1 : -1;
    threads.sort((left, right) => {
      const primary = direction * (this.sortValue(sortField, left) - this.sortValue(sortField, right));
      return primary || direction * String(left.id).localeCompare(String(right.id));
    });
    const limit = Number(params.limit);
    return Number.isFinite(limit) && limit > 0 ? threads.slice(0, limit) : threads;
  }

  listPage(params = {}, actorPrincipalId = undefined) {
    const sortKey = params.sortKey ?? "created_at";
    const sortField = sortKey === "updated_at" || sortKey === "updatedAt" ? "updatedAt"
      : sortKey === "section_position" ? "sectionPosition"
        : sortKey === "recency_at" || sortKey === "recencyAt" ? "recencyAt" : "createdAt";
    const direction = params.sortDirection === "asc" ? 1 : -1;
    const filter = {
      archived: params.archived === true,
      cwd: params.cwd ?? null,
      modelProviders: params.modelProviders ?? null,
      sourceKinds: params.sourceKinds ?? null,
      projectIdPresent: Object.prototype.hasOwnProperty.call(params, "projectId"),
      projectId: params.projectId ?? null,
      searchTerm: typeof params.searchTerm === "string" ? params.searchTerm.trim() : null,
      sectionIdPresent: Object.prototype.hasOwnProperty.call(params, "sectionId"),
      sectionId: params.sectionId ?? null,
      sortField,
      actorPrincipalId: actorPrincipalId ?? null,
      visibilityFiltered: actorPrincipalId !== undefined,
    };
    const signature = cursorFingerprint(JSON.stringify(filter));
    const cacheKey = JSON.stringify({ ...filter, direction });
    this.catalogCache ??= new Map();
    let projected = this.catalogCache.get(cacheKey);
    if (!projected) {
      const ordered = this.list(
        { ...params, cursor: undefined, limit: undefined, sortKey, sortDirection: direction === 1 ? "asc" : "desc" },
        actorPrincipalId,
      );
      projected = ordered.map((thread) => ({ ...thread, turns: [] }));
      if (this.catalogCache.size >= 128) this.catalogCache.delete(this.catalogCache.keys().next().value);
      this.catalogCache.set(cacheKey, projected);
    }

    const cursor = decodeThreadCursor(params.cursor, signature, sortField);
    let start = 0;
    if (cursor) {
      const exact = projected.findIndex((thread) => thread.id === cursor.id && this.sortValue(sortField, thread) === cursor.value);
      if (exact >= 0) start = exact + 1;
      else {
        const compareAnchor = (thread) => {
          const primary = direction * (this.sortValue(sortField, thread) - cursor.value);
          if (primary !== 0) return primary;
          return direction * String(thread.id).localeCompare(cursor.id);
        };
        start = projected.findIndex((thread) => compareAnchor(thread) > 0);
        if (start < 0) start = projected.length;
      }
    }
    const requestedLimit = Number(params.limit);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const data = projected.slice(start, start + limit);
    return {
      data,
      nextCursor: start + data.length < projected.length && data.length > 0
        ? encodeThreadCursor(signature, sortField, data[data.length - 1], this.sortValue(sortField, data[data.length - 1]))
        : null,
      backwardsCursor: data.length > 0
        ? encodeThreadCursor(signature, sortField, data[0], this.sortValue(sortField, data[0]))
        : null,
    };
  }

  sortValue(sortField, thread) {
    if (sortField === "sectionPosition") return this.sectionPositions?.get(thread.id) ?? Number.MAX_SAFE_INTEGER;
    return Number(thread[sortField] ?? 0);
  }

  archive(threadId) {
    const thread = this.get(threadId);
    for (const guard of this.archiveGuards ?? []) guard(threadId, thread);
    this.archivedThreadIds.add(threadId);
    if (!thread.ephemeral) this.persist();
    else this.invalidateCatalog();
    for (const listener of this.archiveListeners ?? []) listener(threadId, thread);
    return thread;
  }

  onArchive(listener) {
    this.archiveListeners ??= new Set();
    this.archiveListeners.add(listener);
    return () => this.archiveListeners.delete(listener);
  }

  isArchived(threadId) {
    return this.archivedThreadIds.has(threadId);
  }

  unarchive(threadId) {
    const thread = this.get(threadId);
    this.archivedThreadIds.delete(threadId);
    if (!thread.ephemeral) this.persist();
    else this.invalidateCatalog();
    for (const listener of this.unarchiveListeners ?? []) listener(threadId, thread);
    return thread;
  }

  onUnarchive(listener) {
    this.unarchiveListeners ??= new Set();
    this.unarchiveListeners.add(listener);
    return () => this.unarchiveListeners.delete(listener);
  }

  touch(threadId, input = [], metadata = {}) {
    const thread = this.ensure(threadId, {}, metadata);
    const now = Math.floor(Date.now() / 1000);
    const firstText = input.find((item) => item?.type === "text" && item.text)?.text;
    if (!thread.preview && firstText) thread.preview = firstText.slice(0, 240);
    if (thread.name === `${CLOUD_THREAD_PREFIX} New chat` && firstText) {
      if (this.titleService) {
        this.titleService.set(thread.id, firstText, { source: "first-message", persistThread: false });
      } else {
        thread.name = cloudThreadName(null, firstText);
      }
    }
    thread.updatedAt = now;
    thread.recencyAt = now;
    this.persistThread(thread.id);
    return thread;
  }

  project(threadId, source = {}, mapPath = (value) => value) {
    const thread = this.get(threadId);
    if (typeof source.name === "string" && source.name.trim()) {
      if (this.titleService) {
        this.titleService.set(thread.id, source.name, { source: "backend", persistThread: false });
      } else {
        thread.name = cloudThreadName(source.name, source.preview ?? thread.preview);
      }
    }
    if (typeof source.preview === "string") thread.preview = source.preview;
    if (typeof source.cwd === "string") thread.cwd = mapPath(source.cwd);
    if (typeof source.modelProvider === "string") thread.modelProvider = source.modelProvider;
    if (Array.isArray(source.turns)) {
      thread.turns = mergeProjectedTurns(thread.turns, source.turns);
    }
    if (source.status && typeof source.status === "object") {
      const projectedActiveWithoutActiveTurn = source.status.type === "active" &&
        Array.isArray(source.turns) &&
        !thread.turns.some((turn) => turn.status === "inProgress");
      if (!projectedActiveWithoutActiveTurn) thread.status = source.status;
    }
    if (Number.isFinite(source.updatedAt)) thread.updatedAt = source.updatedAt;
    if (Number.isFinite(source.recencyAt)) thread.recencyAt = source.recencyAt;
    if (typeof source.path === "string") thread.path = mapPath(source.path);
    if (source.projectId !== undefined && (source.projectId !== null || thread.projectId == null)) {
      thread.projectId = source.projectId;
    }
    if (source.gitInfo !== undefined) thread.gitInfo = source.gitInfo;
    this.persistThread(thread.id);
    return thread;
  }

  projectTurn(threadId, sourceTurn, phase = null) {
    if (!sourceTurn?.id) return this.get(threadId);
    const thread = this.get(threadId);
    thread.turns = mergeProjectedTurns(thread.turns, [sourceTurn]);
    const turn = thread.turns.find((candidate) => candidate.id === sourceTurn.id);
    if (phase === "started" && turn?.status === "inProgress") {
      thread.status = { type: "active", activeFlags: [] };
    } else if (phase === "completed" && !thread.turns.some((candidate) => candidate.status === "inProgress")) {
      thread.status = { type: "idle" };
    }
    if (Number.isFinite(turn?.completedAt)) {
      thread.updatedAt = Math.max(thread.updatedAt ?? 0, turn.completedAt);
      thread.recencyAt = Math.max(thread.recencyAt ?? 0, turn.completedAt);
    }
    this.persistThread(thread.id);
    return thread;
  }

  reconcileInterruptedRuntime(threadId, now = Math.floor(Date.now() / 1_000)) {
    const thread = this.find(threadId);
    if (!thread) return [];
    const interrupted = [];
    let changed = false;
    thread.turns = (thread.turns ?? []).map((turn) => {
      if (turn?.status !== "inProgress") return turn;
      changed = true;
      const completedAt = Number.isFinite(turn.completedAt) ? turn.completedAt : now;
      const startedAt = Number.isFinite(turn.startedAt) ? turn.startedAt : null;
      const next = {
        ...turn,
        status: "interrupted",
        error: null,
        completedAt,
        durationMs: Number.isFinite(turn.durationMs)
          ? turn.durationMs
          : startedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1_000),
      };
      interrupted.push(next);
      return next;
    });
    if (thread.status?.type === "active" || interrupted.length > 0) {
      thread.status = { type: "idle" };
      changed = true;
    }
    if (changed) {
      this.persistThread(thread.id);
    }
    return interrupted;
  }

  forget(threadId) {
    const thread = this.find(threadId);
    if (!thread) return;
    this.threads.delete(threadId);
    this.metadata.delete(threadId);
    this.archivedThreadIds.delete(threadId);
    this.titleService?.remove(threadId);
    if (!thread.ephemeral) this.persist();
    else this.invalidateCatalog();
  }

  markRoot(threadId) {
    this.markSystem(threadId, "management");
  }

  markSystem(threadId, kind) {
    const metadata = this.metadata.get(threadId);
    if (!metadata) throw new Error(`unknown mock thread: ${threadId}`);
    metadata.kind = kind;
    metadata.visibility = "nodeShared";
    this.persist();
  }

  promoteToTransparentCodex(threadId) {
    const metadata = this.metadata.get(threadId);
    if (!metadata || this.isTransparentCodex(threadId)) return false;
    if (metadata.kind === "conversation") metadata.kind = "transparentCodex";
    else if (metadata.kind === "management") metadata.executionFacade = "appServer";
    else return false;
    this.persist();
    return true;
  }

  isRoot(threadId) {
    return this.metadata.get(threadId)?.kind === "management";
  }

  isSystem(threadId) {
    return ["management", "all"].includes(this.metadata.get(threadId)?.kind);
  }

  isTransparentCodex(threadId) {
    const metadata = this.metadata.get(threadId);
    return metadata?.kind === "transparentCodex" || metadata?.executionFacade === "appServer";
  }

  metadataFor(threadId) {
    const metadata = this.metadata.get(threadId);
    return metadata ? { ...metadata } : null;
  }

  ownerOf(threadId) {
    return this.metadata.get(threadId)?.ownerPrincipalId ?? null;
  }

  changed(threadId) {
    const thread = this.get(threadId);
    if (!thread.ephemeral) this.persist();
    else this.invalidateCatalog();
  }

  attachTitleService(service) {
    if (this.titleService && this.titleService !== service) {
      throw new Error("thread title service is already attached");
    }
    this.titleService = service;
    return () => {
      if (this.titleService === service) this.titleService = null;
    };
  }

  setProject(threadId, projectId, options = {}) {
    const thread = this.get(threadId);
    const nextProjectId = projectId ?? null;
    if ((thread.projectId ?? null) === nextProjectId) return thread;
    thread.projectId = nextProjectId;
    if (options.touch !== false) thread.updatedAt = Math.floor(Date.now() / 1000);
    if (options.persist !== false) this.persistThread(thread.id);
    return thread;
  }

  moveToSection(threadId, section, beforeThreadId = null) {
    const thread = this.get(threadId);
    if (section == null && beforeThreadId != null) {
      throw new Error("beforeThreadId requires a non-null sectionId");
    }
    if (beforeThreadId === threadId) throw new Error(`thread ${threadId} cannot be moved before itself`);
    if (beforeThreadId != null && this.get(beforeThreadId).section?.id !== section?.id) {
      throw new Error(`before thread ${beforeThreadId} is not in section ${section.id}`);
    }

    if (section == null) {
      thread.section = null;
      thread.sectionEnteredAt = null;
      this.sectionPositions.delete(threadId);
      this.changed(threadId);
      return thread;
    }

    const previousSectionId = thread.section?.id ?? null;
    const ordered = [...this.threads.values()]
      .filter((candidate) => candidate.id !== threadId && candidate.section?.id === section.id)
      .sort((left, right) => (this.sectionPositions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (this.sectionPositions.get(right.id) ?? Number.MAX_SAFE_INTEGER) || String(left.id).localeCompare(String(right.id)));
    const insertionIndex = beforeThreadId == null
      ? ordered.length
      : ordered.findIndex((candidate) => candidate.id === beforeThreadId);
    ordered.splice(insertionIndex < 0 ? ordered.length : insertionIndex, 0, thread);
    ordered.forEach((candidate, index) => this.sectionPositions.set(candidate.id, (index + 1) * 1_000_000));
    thread.section = { ...section };
    if (previousSectionId !== section.id) thread.sectionEnteredAt = Math.floor(Date.now() / 1000);
    this.changed(threadId);
    return thread;
  }

  clearSection(sectionId) {
    let changed = false;
    for (const thread of this.threads.values()) {
      if (thread.section?.id !== sectionId) continue;
      thread.section = null;
      thread.sectionEnteredAt = null;
      this.sectionPositions.delete(thread.id);
      changed = true;
    }
    if (changed) this.persist();
  }
}

ThreadManagerService.inject = ["principal", "storage"];
