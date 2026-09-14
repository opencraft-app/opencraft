import { Service } from "@deepseek-ai/cordis";
import {
	MAIN_WORKSPACE_VIEW,
	logicalPathForView,
} from "./workspace-view.js";

export const WORKSPACE_ROOT = "/workspace";
export const WORKSPACE_CODEX_HOME = `${WORKSPACE_ROOT}/.codex`;
const USER_CODEX_HOME = "/localhost/.codex";
const CONTAINER_USERS_ROOT = "/run/hypernode-users";
const WORKSPACE_SQLITE_ROOT = "hypernode/workspace-sqlite";

function normalizePhysicalPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
}

export function workspacePhysicalPathToVirtual(path, mountPath) {
  const value = normalizePhysicalPath(path);
  const mount = normalizePhysicalPath(mountPath);
  if (!value || !mount || mount === "/") return value ?? path;
  if (value !== mount && !value.startsWith(`${mount}/`)) return value;
  return `${WORKSPACE_ROOT}${value.slice(mount.length)}`;
}

export function normalizeWorkspacePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("workspace paths must be absolute");
  }
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("workspace path escapes the virtual root");
      parts.pop();
    } else parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`path is outside ${WORKSPACE_ROOT}: ${normalized}`);
  }
  return normalized;
}

export function isWorkspaceControlPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`)) return false;
  const normalized = normalizeWorkspacePath(path);
  return normalized === WORKSPACE_CODEX_HOME || normalized.startsWith(`${WORKSPACE_CODEX_HOME}/`);
}

export function workspaceControlPathForUser(path) {
  const normalized = normalizeWorkspacePath(path);
  if (!isWorkspaceControlPath(normalized)) {
    throw new Error(`path is outside ${WORKSPACE_CODEX_HOME}: ${normalized}`);
  }
  return `${USER_CODEX_HOME}${normalized.slice(WORKSPACE_CODEX_HOME.length)}`;
}

export function workspaceControlPathInContainer(path, user) {
  const normalized = normalizeWorkspacePath(path);
  if (!isWorkspaceControlPath(normalized)) {
    throw new Error(`path is outside ${WORKSPACE_CODEX_HOME}: ${normalized}`);
  }
  const segment = String(user?.homePath ?? "").split("/").filter(Boolean).at(-1);
  if (!segment || !/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new Error("workspace Codex state requires a valid user home");
  }
  return `${CONTAINER_USERS_ROOT}/${segment}/.codex${normalized.slice(WORKSPACE_CODEX_HOME.length)}`;
}

export function workspaceSqliteHome(containerHome, viewId) {
  const segment = String(viewId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment === "." || segment === "..") {
    throw new Error("workspace Codex SQLite state requires a valid view id");
  }
  return `${containerHome}/.codex/${WORKSPACE_SQLITE_ROOT}/${segment}`;
}

export class WorkspaceFilesystemService extends Service {
  constructor(ctx) {
    super(ctx, "workspaceFilesystem");
    this.v2 = globalThis.hostWorkspaces?.enabled === true;
    this.enabled = this.v2;
    this.supportsPersistentRuntimeFencing = false;
    this.mount = WORKSPACE_ROOT;
    this.physicalRoot = WORKSPACE_ROOT;
    this.hostMount = null;
    this.watchSequence = 0;
    this.watchEntries = new Map();
    this.watchConsumers = new Map();
	this.v2Attachments = new Map();
	this.v2Processes = new Map();
	ctx.effect(() => () => {
	  for (const [processId, process] of this.v2Processes) {
	    try { globalThis.hostWorkspaces.closeProcess(processId); } catch {}
	    process.attachment.detach("filesystemDisposed");
	  }
	  this.v2Processes.clear();
	  for (const attachment of this.v2Attachments.values()) attachment.detach("filesystemDisposed");
	  this.v2Attachments.clear();
	});
  }

  owns(path) {
    if (!this.enabled || typeof path !== "string") return false;
    if (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`)) return false;
    const normalized = normalizeWorkspacePath(path);
    return normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`);
  }

  normalize(path) {
    return normalizeWorkspacePath(path);
  }

  ownsControlPath(path) {
    return isWorkspaceControlPath(path);
  }

  controlPathForUser(path) {
    return workspaceControlPathForUser(path);
  }

  controlPathInContainer(path, user) {
    return workspaceControlPathInContainer(path, user);
  }

  status() {
    return globalThis.hostWorkspaces?.status() ?? { enabled: false };
  }

  storagePath(path, viewId = MAIN_WORKSPACE_VIEW) {
	return logicalPathForView(this.normalize(path), viewId);
  }

	attachmentFor(viewId = MAIN_WORKSPACE_VIEW) {
	  if (!this.v2) return null;
	  const rootThreadId = globalThis.hostWorkspaces.root()?.threadId;
	  const threadId = viewId === MAIN_WORKSPACE_VIEW ? rootThreadId : viewId;
	  if (!threadId) throw new Error("workspace root is not initialized");
	  let attachment = this.v2Attachments.get(threadId);
	  if (!attachment) {
	    attachment = this.ctx.workspaceAttachment.attach({
	      threadId,
	      engineId: `desktop-filesystem:${threadId}`,
	      viewId: threadId,
	      cwd: WORKSPACE_ROOT,
	      filesystem: this,
	      principal: { id: "desktop-filesystem", username: "root" },
	    });
	    if (!attachment.capabilityId) throw new Error("workspace attachment has no host capability");
	    this.v2Attachments.set(threadId, attachment);
	  }
	  return attachment;
	}

  metadata(path, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	return globalThis.hostWorkspaces.metadata(attachment.capabilityId, this.normalize(path));
  }

  readDirectory(path, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	return globalThis.hostWorkspaces.readDirectory(attachment.capabilityId, this.normalize(path));
  }

  readFile(path, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	return globalThis.hostWorkspaces.readFile(attachment.capabilityId, this.normalize(path));
  }

  writeFile(params, bytes, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	globalThis.hostWorkspaces.writeFile(attachment.capabilityId, this.normalize(params.path), bytes);
    return {};
  }

  createDirectory(params, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	globalThis.hostWorkspaces.createDirectory(
	    attachment.capabilityId, this.normalize(params.path), params.recursive !== false,
	);
    return {};
  }

  remove(params, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	globalThis.hostWorkspaces.remove(
	    attachment.capabilityId,
	    this.normalize(params.path),
	    params.recursive !== false,
	    params.force !== false,
	);
    return {};
  }

  copy(params, viewId = MAIN_WORKSPACE_VIEW) {
	const attachment = this.attachmentFor(viewId);
	globalThis.hostWorkspaces.copy(
	    attachment.capabilityId,
	    this.normalize(params.sourcePath),
	    this.normalize(params.destinationPath),
	    params.recursive === true,
	);
    return {};
  }

  execute(params, viewId = MAIN_WORKSPACE_VIEW) {
    if (!this.v2) throw new Error("workspace process execution requires Workspace v2");
    const attachment = this.attachmentFor(viewId);
    const timeout = params.timeoutMs;
    const cap = params.outputBytesCap;
    return globalThis.hostWorkspaces.execute(
      attachment.capabilityId,
      this.normalize(params.cwd),
      params.command,
      params.env ?? {},
      Number.isFinite(timeout) ? Math.floor(timeout) : 0,
      timeout === null,
      Number.isFinite(cap) ? Math.floor(cap) : 0,
      cap === null,
    );
  }

  watch(id, path, viewId = MAIN_WORKSPACE_VIEW) {
    this.unwatch(id);
    // Desktop may reconnect with an old physical view alias. Canonicalize at
    // the input boundary so every consumer of one logical directory shares
    // the same native agent watch.
    const logicalPath = logicalPathForView(this.normalize(path), viewId);
    const key = `${viewId}\0${logicalPath}`;
    let entry = this.watchEntries.get(key);
    if (!entry) {
      const hostId = `workspace-shared-watch-${++this.watchSequence}`;
      // The workspace agent runs inside the selected view, where the public
      // namespace is always /workspace. Physical @main/@fork paths must never
      // cross this transport boundary.
	  const attachment = this.attachmentFor(viewId);
	  globalThis.hostWorkspaces.watch(hostId, attachment.capabilityId, logicalPath);
      entry = { hostId, key, viewId, consumers: new Map() };
      this.watchEntries.set(key, entry);
    }
    const consumer = { entry, pending: new Set() };
    entry.consumers.set(id, consumer);
    this.watchConsumers.set(id, consumer);
  }

  drainWatch(id) {
    const consumer = this.watchConsumers.get(id);
    if (!consumer) return [];
    const { entry } = consumer;
	const changed = globalThis.hostWorkspaces.drainWatch(entry.hostId);
    if (changed.length > 0) {
      for (const target of entry.consumers.values()) {
        // New agents already return logical paths. The mapping is retained as
        // a compatibility boundary for an older agent or a reconnect that
        // still emits an internal view alias.
        for (const path of changed) target.pending.add(logicalPathForView(path, entry.viewId));
      }
    }
    const result = [...consumer.pending];
    consumer.pending.clear();
    return result;
  }

  unwatch(id) {
    const consumer = this.watchConsumers.get(id);
    if (!consumer) return;
    const { entry } = consumer;
    entry.consumers.delete(id);
    this.watchConsumers.delete(id);
    if (entry.consumers.size === 0) {
	  globalThis.hostWorkspaces.unwatch(entry.hostId);
      this.watchEntries.delete(entry.key);
    }
  }

  toPhysical(path, user = null, viewId = MAIN_WORKSPACE_VIEW) {
    // Workspace v2 agents expose one logical /workspace namespace per
    // attachment. Never forward an internal @main/@fork storage alias.
    return logicalPathForView(this.normalize(path), viewId);
  }

  toVirtual(path, user = null, viewId = MAIN_WORKSPACE_VIEW) {
    return logicalPathForView(String(path), viewId);
  }

  ensureWorkingDirectory(path, user = null, viewId = MAIN_WORKSPACE_VIEW) {
    const normalized = this.normalize(path);
	const attachment = this.attachmentFor(viewId);
	globalThis.hostWorkspaces.createDirectory(attachment.capabilityId, normalized, true);
    return normalized;
  }

  spawnAppServer(
    processId, cwd = "/workspace/projects", user = null,
    viewId = MAIN_WORKSPACE_VIEW, providerId = null,
  ) {
    if (!user?.username) throw new Error("workspace Codex requires an authenticated user");
	return this.spawnV2Codex(processId, cwd, user, viewId);
  }

  spawnThreadRuntime(
    processId, cwd = "/workspace/projects", user = null,
    viewId = MAIN_WORKSPACE_VIEW, runtimeId = processId, providerId = null,
  ) {
    if (!user?.username) throw new Error("workspace Codex requires an authenticated user");
	return this.spawnV2Codex(processId, cwd, user, viewId);
  }

  send(processId, message) {
	if (this.v2Processes.has(processId)) {
	  globalThis.hostWorkspaces.writeProcess(
	    processId,
	    `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
	  );
	  return;
	}
	throw new Error(`unknown workspace process: ${processId}`);
  }

  drain(processId) {
	const process = this.v2Processes.get(processId);
	if (process) {
	  const result = globalThis.hostWorkspaces.drainProcess(processId);
	  const stdout = process.stdoutRemainder + Buffer.from(result.stdoutBytes ?? []).toString("utf8");
	  const stderr = process.stderrRemainder + Buffer.from(result.stderrBytes ?? []).toString("utf8");
	  const stdoutParts = stdout.split(/\r?\n/);
	  const stderrParts = stderr.split(/\r?\n/);
	  process.stdoutRemainder = stdoutParts.pop() ?? "";
	  process.stderrRemainder = stderrParts.pop() ?? "";
	  if (result.exited) {
	    if (process.stdoutRemainder) stdoutParts.push(process.stdoutRemainder);
	    if (process.stderrRemainder) stderrParts.push(process.stderrRemainder);
	    process.stdoutRemainder = "";
	    process.stderrRemainder = "";
	  }
	  return { ...result, stdoutLines: stdoutParts, stderrLines: stderrParts };
	}
	throw new Error(`unknown workspace process: ${processId}`);
  }

  kill(processId) {
	const process = this.v2Processes.get(processId);
	if (process) {
	  this.v2Processes.delete(processId);
	  try { globalThis.hostWorkspaces.closeProcess(processId); } finally {
	    process.attachment.detach("processClosed");
	  }
	  return;
	}
	return;
  }

	spawnV2Codex(processId, cwd, user, viewId) {
	  if (this.v2Processes.has(processId)) throw new Error(`duplicate workspace process id: ${processId}`);
	  const rootThreadId = globalThis.hostWorkspaces.root()?.threadId;
	  const threadId = viewId === MAIN_WORKSPACE_VIEW ? rootThreadId : viewId;
	  if (!threadId) throw new Error("workspace root is not initialized");
	  const attachment = this.ctx.workspaceAttachment.attach({
	    threadId,
	    engineId: `codex:${processId}`,
	    viewId: threadId,
	    cwd: this.normalize(cwd),
	    filesystem: this,
	    principal: { id: user.id ?? user.username, username: user.username },
	  });
	  if (!attachment.capabilityId) {
	    attachment.detach("missingCapability");
	    throw new Error("workspace Codex attachment has no host capability");
	  }
	  const segment = String(user.homePath ?? "").split("/").filter(Boolean).at(-1);
	  if (!segment) {
	    attachment.detach("missingUserHome");
	    throw new Error("workspace Codex requires a durable user home");
	  }
	  const containerHome = `${CONTAINER_USERS_ROOT}/${segment}`;
	  const sqliteHome = workspaceSqliteHome(containerHome, viewId);
	  try {
	    globalThis.hostWorkspaces.startProcess(
	      processId,
	      attachment.capabilityId,
	      this.normalize(cwd),
	      ["codex", "app-server", "--listen", "stdio://"],
	      {
	        HOME: containerHome,
	        // The runc mount aliases this same account-scoped directory at the
	        // public Workspace path.  Codex therefore advertises Skills and
	        // attachments inside the granted Workspace instead of teaching the
	        // model a private /run/hypernode-users path that invites needless
	        // sandbox escalation.
	        CODEX_HOME: WORKSPACE_CODEX_HOME,
	        // Authentication, configuration, Skills and MCP/plugin caches remain
	        // account-scoped in CODEX_HOME.  SQLite is runtime metadata: sharing
	        // it across isolated Workspace views leaves rollout paths pointing
	        // at another view and forces Codex to repair/fallback-scan them on
	        // every cold start.  Keep that state durable but view-local.
	        CODEX_SQLITE_HOME: sqliteHome,
	        USER: "root",
	        LOGNAME: "root",
	        HYPERNODE_USER: user.username,
	        GIT_CONFIG_COUNT: "1",
	        GIT_CONFIG_KEY_0: "safe.directory",
	        GIT_CONFIG_VALUE_0: "*",
	      },
	      0,
	      true,
	      0,
	      true,
	      true,
	    );
	    this.v2Processes.set(processId, {
	      attachment,
	      stdoutRemainder: "",
	      stderrRemainder: "",
	    });
	  } catch (error) {
	    attachment.detach("processStartFailed");
	    throw error;
	  }
	}

  terminateThreadRuntime(
    processId, viewId = MAIN_WORKSPACE_VIEW, runtimeId = processId, timeoutMs = 5_000,
  ) {
    this.kill(processId);
  }
}

WorkspaceFilesystemService.inject = ["virtualFilesystem", "workspaceAttachment"];
