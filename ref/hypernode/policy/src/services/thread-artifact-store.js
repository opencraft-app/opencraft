import { Service } from "@deepseek-ai/cordis";
import { uuidV7 } from "./thread-identity.ts";

const ROOT = "/workspace/.hypernode/threads";

function safeId(value, label) {
  const result = String(value ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(result)) throw new Error(`invalid ${label}`);
  return result;
}

function utf8(bytes) {
  if (typeof bytes === "string") return bytes;
  return Buffer.from(bytes).toString("utf8");
}

const RESPONSE_ITEM_ID = /^[A-Za-z0-9_-]+$/;

// These IDs are minted by HyperNode's Chat Completions -> Responses adapter.
// They are locally useful while projecting one streamed response, but they are
// never persisted by the upstream provider and must not cross into a native
// OpenAI/ChatGPT rollout.  Some of them deliberately resemble native item IDs
// (notably rs_resp_chat_*), so syntax and type-prefix validation alone cannot
// establish provider ownership.
const HYPERNODE_SYNTHETIC_RESPONSE_ITEM_ID = /^(?:rs_resp_chat_|resp_chat_|msg_hypernode(?:_|$)|hn_)/;

function responseItemIdPrefix(type) {
  switch (type) {
    case "message": return "msg";
    case "reasoning": return "rs";
    case "function_call":
    case "local_shell_call":
    case "shell_call":
    case "computer_call":
    case "mcp_tool_call":
      return "fc";
    case "custom_tool_call": return "ctc";
    case "tool_search_call": return "tsc";
    case "web_search_call": return "ws";
    default: return null;
  }
}

function stripUntrustedResponseItemId(item, { stripProviderOwned = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (typeof item.id !== "string") return false;
  // item_reference.id is a required reference, not an upstream-owned output
  // item id. Never turn it into a malformed reference by deleting it here. A
  // provider transition cannot carry such an opaque reference at all because
  // its payload is absent and the destination provider cannot resolve it.
  if (item.type === "item_reference") {
    if (stripProviderOwned) {
      throw new Error(`rollout contains non-portable item_reference: ${item.id}`);
    }
    return false;
  }
  const prefix = responseItemIdPrefix(item.type);
  if (!stripProviderOwned && !HYPERNODE_SYNTHETIC_RESPONSE_ITEM_ID.test(item.id) &&
      RESPONSE_ITEM_ID.test(item.id) && (!prefix || item.id.startsWith(prefix))) return false;
  delete item.id;
  return true;
}

// Chat-compatible providers often reuse their tool call id as a Responses
// output item id.  That value is safe as call_id (where it pairs the call and
// result) but is not necessarily a valid OpenAI provider-owned item id.  Strip
// only the latter at the durable rollout boundary; OpenAI can assign a fresh
// item id while the call_id relationship remains intact.
export function sanitizeRolloutResponseItemIds(bytes, { stripProviderOwned = false } = {}) {
  const source = utf8(bytes);
  const lines = source.split("\n");
  let changed = false;
  let stripped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let value;
    try {
      value = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    let lineChanged = false;
    if (value?.type === "response_item") {
      lineChanged = stripUntrustedResponseItemId(value.payload, { stripProviderOwned });
      if (lineChanged) stripped += 1;
    } else if (value?.type === "compacted" && Array.isArray(value.payload?.replacement_history)) {
      for (const item of value.payload.replacement_history) {
        if (stripUntrustedResponseItemId(item, { stripProviderOwned })) {
          lineChanged = true;
          stripped += 1;
        }
      }
    }
    if (!lineChanged) continue;
    lines[index] = JSON.stringify(value);
    changed = true;
  }
  return {
    bytes: changed ? Buffer.from(lines.join("\n"), "utf8") : Buffer.from(source, "utf8"),
    changed,
    stripped,
  };
}

export function rewriteRolloutIdentity(bytes, nextThreadId, expectedThreadId = null) {
  safeId(nextThreadId, "inner thread id");
  const source = utf8(bytes);
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline;
    const line = source.slice(offset, end);
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      value = null;
    }
    if (value?.type === "session_meta" && value.payload && typeof value.payload === "object") {
      const previousThreadId = value.payload.id ?? value.payload.session_id;
      if (typeof previousThreadId !== "string" || !previousThreadId) {
        throw new Error("rollout session_meta has no thread identity");
      }
      if (expectedThreadId && previousThreadId !== expectedThreadId) {
        throw new Error(
          `rollout identity mismatch: expected ${expectedThreadId}, found ${previousThreadId}`,
        );
      }
      value.payload.id = nextThreadId;
      value.payload.session_id = nextThreadId;
      if (previousThreadId !== nextThreadId) value.payload.forked_from_id = previousThreadId;
      const rewritten = `${source.slice(0, offset)}${JSON.stringify(value)}${source.slice(end)}`;
      return {
        bytes: Buffer.from(rewritten, "utf8"),
        previousThreadId,
        innerThreadId: nextThreadId,
      };
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  throw new Error("rollout has no session_meta record");
}

export function rewriteRolloutModelProvider(bytes, modelProvider) {
  const provider = safeId(modelProvider, "model provider");
  const source = utf8(bytes);
  const lines = source.split("\n");
  let sessionMetaCount = 0;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let value;
    try {
      value = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (value?.type !== "session_meta" || !value.payload || typeof value.payload !== "object") {
      continue;
    }
    sessionMetaCount += 1;
    if (value.payload.model_provider === provider) continue;
    value.payload.model_provider = provider;
    lines[index] = JSON.stringify(value);
    changed = true;
  }
  if (sessionMetaCount === 0) throw new Error("rollout has no session_meta record");
  return {
    bytes: changed ? Buffer.from(lines.join("\n"), "utf8") : Buffer.from(source, "utf8"),
    modelProvider: provider,
    sessionMetaCount,
    changed,
  };
}

export function resumeHistoryFromRollout(bytes) {
  const source = utf8(bytes);
  let historyMode = null;
  let sessionMetaSeen = false;
  let history = [];
  let lineNumber = 0;
  for (const line of source.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid rollout JSON at line ${lineNumber}: ${error.message || error}`);
    }
    if (value?.type === "session_meta") {
      sessionMetaSeen = true;
      historyMode = value.payload?.history_mode ?? "legacy";
      continue;
    }
    if (value?.type === "compacted") {
      const replacement = value.payload?.replacement_history;
      if (Array.isArray(replacement)) {
        history = [...replacement];
      } else if (typeof value.payload?.message === "string" && value.payload.message) {
        history = [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: value.payload.message }],
        }];
      }
      continue;
    }
    if (value?.type === "response_item" && value.payload && typeof value.payload === "object") {
      history.push(value.payload);
    }
  }
  if (!sessionMetaSeen) throw new Error("rollout has no session_meta record");
  if (historyMode !== "paginated") return null;
  if (history.length === 0) throw new Error("paginated rollout has no resumable response history");
  return history;
}

/**
 * Parses a rollout JSONL once and derives every handoff product from the same
 * records.  Identity/provider rewrites, response-item portability and
 * paginated resume history used to be four independent whole-file passes.
 *
 * The source and result remain byte buffers because the Workspace filesystem
 * ABI is request/response based, but every non-empty JSONL record is decoded
 * exactly once and the destination is serialized at most once.
 */
export function transformRolloutForHandoff(bytes, {
  nextThreadId = null,
  expectedThreadId = null,
  modelProvider = null,
} = {}) {
  const source = utf8(bytes);
  const provider = modelProvider == null ? null : safeId(modelProvider, "model provider");
  if (nextThreadId != null) safeId(nextThreadId, "inner thread id");

  const lines = source.split("\n").map((raw) => ({ raw, value: null, changed: false }));
  const portableItems = [];
  let parsedLines = 0;
  let sessionMetaSeen = false;
  let sessionMetaCount = 0;
  let previousThreadId = null;
  let identityRewritten = false;
  let providerChanged = false;
  let historyMode = null;
  let history = [];

  for (let index = 0; index < lines.length; index += 1) {
    const state = lines[index];
    if (!state.raw.trim()) continue;
    try {
      state.value = JSON.parse(state.raw);
      parsedLines += 1;
    } catch (error) {
      throw new Error(`invalid rollout JSON at line ${index + 1}: ${error.message || error}`);
    }
    const value = state.value;
    if (value?.type === "session_meta") {
      sessionMetaSeen = true;
      historyMode = value.payload?.history_mode ?? "legacy";
      if (!value.payload || typeof value.payload !== "object") continue;
      sessionMetaCount += 1;
      if (nextThreadId != null && !identityRewritten) {
        previousThreadId = value.payload.id ?? value.payload.session_id;
        if (typeof previousThreadId !== "string" || !previousThreadId) {
          throw new Error("rollout session_meta has no thread identity");
        }
        if (expectedThreadId && previousThreadId !== expectedThreadId) {
          throw new Error(
            `rollout identity mismatch: expected ${expectedThreadId}, found ${previousThreadId}`,
          );
        }
        value.payload.id = nextThreadId;
        value.payload.session_id = nextThreadId;
        if (previousThreadId !== nextThreadId) value.payload.forked_from_id = previousThreadId;
        identityRewritten = true;
        state.changed = true;
      }
      if (provider != null && value.payload.model_provider !== provider) {
        value.payload.model_provider = provider;
        providerChanged = true;
        state.changed = true;
      }
      continue;
    }
    if (value?.type === "compacted") {
      const replacement = value.payload?.replacement_history;
      if (Array.isArray(replacement)) {
        history = [...replacement];
        for (const item of replacement) portableItems.push({ item, state });
      } else if (typeof value.payload?.message === "string" && value.payload.message) {
        history = [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: value.payload.message }],
        }];
      }
      continue;
    }
    if (value?.type === "response_item" && value.payload && typeof value.payload === "object") {
      history.push(value.payload);
      portableItems.push({ item: value.payload, state });
    }
  }

  if (!sessionMetaSeen) throw new Error("rollout has no session_meta record");
  if (provider != null && sessionMetaCount === 0) {
    throw new Error("rollout has no session_meta record");
  }
  if (nextThreadId != null && !identityRewritten) {
    throw new Error("rollout has no session_meta record");
  }

  let stripped = 0;
  for (const candidate of portableItems) {
    if (!stripUntrustedResponseItemId(candidate.item, {
      stripProviderOwned: providerChanged,
    })) continue;
    candidate.state.changed = true;
    stripped += 1;
  }

  const resumeHistory = historyMode === "paginated" ? history : null;
  if (historyMode === "paginated" && history.length === 0) {
    throw new Error("paginated rollout has no resumable response history");
  }
  const changed = identityRewritten || providerChanged || stripped > 0;
  return {
    bytes: changed
      ? Buffer.from(lines.map((state) => state.changed
        ? JSON.stringify(state.value)
        : state.raw).join("\n"), "utf8")
      : Buffer.from(source, "utf8"),
    changed,
    identityRewritten,
    previousThreadId,
    innerThreadId: nextThreadId,
    modelProvider: provider,
    providerChanged,
    sessionMetaCount,
    stripped,
    resumeHistory,
    parsedLines,
  };
}

export class ThreadArtifactTable {
  constructor({ driver, hostMount = null, load = () => null, save = () => {}, createThreadId = uuidV7 } = {}) {
    this.driver = driver;
    this.hostMount = hostMount;
    this.load = load;
    this.save = save;
    this.createThreadId = createThreadId;
    this.records = new Map();
    const snapshot = load();
    if (snapshot?.version === 1 && Array.isArray(snapshot.records)) {
      for (const record of snapshot.records) {
        if (typeof record.threadId === "string" && Number.isInteger(record.generation)) {
          this.records.set(record.threadId, record);
        }
      }
    }
  }

  persist() {
    this.save({ version: 1, records: [...this.records.values()] });
  }

  logicalPath(threadId, generation) {
    return `${ROOT}/${safeId(threadId, "thread id")}/generation-${safeId(generation, "generation")}.jsonl`;
  }

  logicalSource(path) {
    if (typeof path !== "string") return null;
    if (path === "/workspace" || path.startsWith("/workspace/")) return path;
    if (this.hostMount && (path === this.hostMount || path.startsWith(`${this.hostMount}/`))) {
      return `/workspace${path.slice(this.hostMount.length)}`;
    }
    return null;
  }

  prepare(
    threadId, sourcePath, epoch, sourceInnerThreadId,
    { reidentify = false, modelProvider = null } = {},
  ) {
    if (!this.driver?.enabled) throw new Error("thread artifact store requires the persistent workspace");
    if (typeof sourceInnerThreadId !== "string" || !sourceInnerThreadId) {
      throw new Error("source inner thread id is required");
    }
    const previous = this.records.get(threadId) ?? null;
    const generation = Math.max(previous?.generation ?? 0, Number(epoch) || 0) + 1;
    const destination = this.logicalPath(threadId, generation);
    const innerThreadId = reidentify ? this.createThreadId() : sourceInnerThreadId;
    this.driver.createDirectory(destination.slice(0, destination.lastIndexOf("/")), true);
    try {
      const logicalSource = this.logicalSource(sourcePath);
      const sourceBytes = logicalSource
        ? this.driver.readFile(logicalSource)
        : this.driver.readLegacyArtifact(sourcePath);
      const transformed = transformRolloutForHandoff(sourceBytes, {
        nextThreadId: reidentify ? innerThreadId : null,
        expectedThreadId: reidentify ? sourceInnerThreadId : null,
        modelProvider,
      });
      if (transformed.changed) {
        this.driver.writeFile(destination, transformed.bytes);
      } else if (logicalSource) {
        this.driver.copy(logicalSource, destination, false);
      } else {
        this.driver.importArtifact(sourcePath, destination);
      }
      return {
        threadId,
        innerThreadId,
        parentInnerThreadId: sourceInnerThreadId,
        reidentified: reidentify,
        generation,
        parentGeneration: previous?.generation ?? null,
        path: destination,
        previous,
        status: "working",
        resumeHistory: transformed.resumeHistory,
        transformStats: {
          parsedLines: transformed.parsedLines,
          strippedResponseItemIds: transformed.stripped,
          providerChanged: transformed.providerChanged,
        },
      };
    } catch (error) {
      try { this.driver.remove(destination, false, true); } catch {}
      throw error;
    }
  }

  commit(artifact, accountIdentity, epoch, ownerUserId = null) {
    const record = {
      threadId: artifact.threadId,
      innerThreadId: artifact.innerThreadId,
      parentInnerThreadId: artifact.parentInnerThreadId,
      generation: artifact.generation,
      path: artifact.path,
      accountIdentity,
      ownerUserId,
      epoch,
      committedAtMs: Date.now(),
    };
    this.records.set(record.threadId, record);
    this.persist();
    return record;
  }

  discard(artifact) {
    if (!artifact?.path) return;
    this.driver.remove(artifact.path, false, true);
  }

  current(threadId) {
    return this.records.get(threadId) ?? null;
  }

  values() {
    return this.records.values();
  }

  findLegacySource(user, innerThreadId) {
    if (!user?.homePath) return null;
    try {
      return this.driver.findUserRollout(user.homePath, innerThreadId);
    } catch {
      return null;
    }
  }

  readSource(path) {
    const logicalSource = this.logicalSource(path);
    if (logicalSource) return this.driver.readFile(logicalSource);
    return this.driver.readLegacyArtifact(path);
  }

  runtimePath(path, realm) {
    if (realm === "workspace") return path;
    if (!this.hostMount) throw new Error("workspace host mount is unavailable");
    return `${this.hostMount}${path.slice("/workspace".length)}`;
  }

  resumeHistory(path) {
    return resumeHistoryFromRollout(this.driver.readFile(path));
  }

  ensureModelProvider(path, modelProvider) {
    const rewritten = rewriteRolloutModelProvider(this.driver.readFile(path), modelProvider);
    const sanitized = sanitizeRolloutResponseItemIds(rewritten.bytes, {
      stripProviderOwned: rewritten.changed,
    });
    if (rewritten.changed || sanitized.changed) this.driver.writeFile(path, sanitized.bytes);
    return {
      ...rewritten,
      changed: rewritten.changed || sanitized.changed,
      providerChanged: rewritten.changed,
      responseItemIdsStripped: sanitized.stripped,
    };
  }
}

export class CodexRolloutArtifactStoreService extends Service {
  constructor(ctx) {
    super(ctx, "threadArtifactStore");
    const principal = ctx.principal.current();
    const viewFor = (path) => {
      const match = String(path).match(/^\/workspace\/\.hypernode\/threads\/([^/]+)\//);
      if (!match) {
        throw new Error(`artifact path has no owning thread: ${path}`);
      }
      return match[1];
    };
    const filesystem = ctx.workspaceFilesystem;
    const driver = {
      enabled: filesystem.enabled,
      createDirectory: (path, recursive) => filesystem.createDirectory(
        { path, recursive }, viewFor(`${path}/placeholder`),
      ),
      copy: (source, destination, recursive) => filesystem.copy(
        { sourcePath: source, destinationPath: destination, recursive }, viewFor(destination),
      ),
      importArtifact: (source, destination) => filesystem.writeFile(
        { path: destination }, hostIdentity.readUserRollout(source), viewFor(destination),
      ),
      readLegacyArtifact: (path) => hostIdentity.readUserRollout(path),
      readFile: (path) => filesystem.readFile(path, viewFor(path)),
      writeFile: (path, bytes) => filesystem.writeFile({ path }, bytes, viewFor(path)),
      remove: (path, recursive, force) => filesystem.remove(
        { path, recursive, force }, viewFor(path),
      ),
      findUserRollout: (home, threadId) => hostIdentity.findUserRollout(home, threadId),
    };
    this.table = new ThreadArtifactTable({
      driver,
      hostMount: null,
      load: () => {
        const encoded = policyStore.get("threadArtifactStore", principal.id);
        return encoded == null ? null : JSON.parse(encoded);
      },
      save: (snapshot) => policyStore.set("threadArtifactStore", principal.id, JSON.stringify(snapshot)),
    });
    ctx.effect(() => ctx.appServer.register("hypernode/threadArtifact/read", (params) => ({
      artifact: this.table.current(params.threadId),
    })));
  }

  prepare(...args) { return this.table.prepare(...args); }
  commit(...args) { return this.table.commit(...args); }
  discard(...args) { return this.table.discard(...args); }
  current(...args) { return this.table.current(...args); }
  values(...args) { return this.table.values(...args); }
  findLegacySource(...args) { return this.table.findLegacySource(...args); }
  readSource(...args) { return this.table.readSource(...args); }
  runtimePath(...args) { return this.table.runtimePath(...args); }
  resumeHistory(...args) { return this.table.resumeHistory(...args); }
  ensureModelProvider(...args) { return this.table.ensureModelProvider(...args); }
}

CodexRolloutArtifactStoreService.inject = ["appServer", "principal", "workspaceFilesystem"];

// Compatibility name for the existing Cordis injection key and external tests.
// The store contains Codex rollout artifacts only; DSH never reads from it.
export const ThreadArtifactStoreService = CodexRolloutArtifactStoreService;
