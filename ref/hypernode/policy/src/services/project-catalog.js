import { Service } from "@deepseek-ai/cordis";
import { uuidV7 } from "./thread-identity.ts";
import { LOGICAL_PROJECTS_ROOT, canonicalWorkspaceCwd } from "./workspace-view.js";

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function normalizedPath(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("project root path must not be empty");
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function pathContains(root, cwd) {
  const parent = normalizedPath(root);
  const child = normalizedPath(cwd);
  return child === parent || child.startsWith(`${parent}/`);
}

function projectNameFromRoot(path) {
  return normalizedPath(path).split("/").filter(Boolean).at(-1) ?? "Project";
}

function stableHash(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function authoritativeProjectId(root) {
  const value = normalizedPath(root);
  return `project-hypernode-${stableHash(value, 2166136261)}${stableHash(value, 2654435769)}`;
}

export function inferAuthoritativeProjectRoot(cwd) {
  if (typeof cwd !== "string" || !cwd.startsWith("/workspace")) return null;
  const logical = canonicalWorkspaceCwd(cwd);
  if (!logical.startsWith(`${LOGICAL_PROJECTS_ROOT}/`)) return null;
  const suffix = logical.slice(`${LOGICAL_PROJECTS_ROOT}/`.length);
  const projectName = suffix.split("/")[0];
  return projectName ? `${LOGICAL_PROJECTS_ROOT}/${projectName}` : null;
}

export class ProjectCatalogService extends Service {
  constructor(ctx) {
    super(ctx, "projectCatalog");
    this.ctx = ctx;
    this.principal = ctx.principal.current();
    this.projects = new Map();
    this.idempotency = new Map();
    this.projectListeners = new Set();
    this.bindingService = null;
    this.catalogRevision = 0;
    this.catalogCache = null;
    this.load();

    const register = (method, handler) => ctx.effect(() => ctx.appServer.register(method, handler));
    register("project/list", (params) => this.list(params));
    register("project/read", (params) => ({ project: this.get(params.projectId) }));
    register("project/create", (params, connection) => ({ project: this.create(params, connection) }));
    register("project/import", (params, connection) => ({ project: this.create(params, connection, true) }));
    register("project/update", (params, connection) => ({ project: this.update(params, connection) }));
    register("project/move", (params, connection) => this.move(params, connection));
    register("project/delete", (params, connection) => this.delete(params, connection));
  }

  load() {
    const encoded = policyStore.get("projectCatalog", this.principal.id);
    if (encoded == null) return;
    const snapshot = JSON.parse(encoded);
    if (![1, 2].includes(snapshot.version) || !Array.isArray(snapshot.projects)) {
      throw new Error("unsupported persisted project catalog");
    }
    let normalized = false;
    for (const project of snapshot.projects) {
      const roots = this.normalizeRoots(project.roots).map((root) => ({
        path: canonicalWorkspaceCwd(root.path),
      }));
      if (JSON.stringify(roots) !== JSON.stringify(project.roots)) normalized = true;
      project.roots = roots;
      if (project.metadata?.logicalRoot) {
        const logicalRoot = canonicalWorkspaceCwd(project.metadata.logicalRoot);
        if (logicalRoot !== project.metadata.logicalRoot) normalized = true;
        project.metadata.logicalRoot = logicalRoot;
      }
      this.projects.set(project.id, project);
    }
    for (const [key, projectId] of snapshot.idempotency ?? []) this.idempotency.set(key, projectId);
    this.catalogRevision = Number(snapshot.catalogRevision) || 0;
    if (normalized) this.persist();
  }

  persist() {
    this.catalogRevision += 1;
    this.catalogCache = null;
    policyStore.set("projectCatalog", this.principal.id, JSON.stringify({
      version: 2,
      catalogRevision: this.catalogRevision,
      projects: [...this.projects.values()],
      idempotency: [...this.idempotency.entries()],
    }));
  }

  attachBindingService(service) {
    if (this.bindingService && this.bindingService !== service) {
      throw new Error("project binding service is already attached");
    }
    this.bindingService = service;
    return () => {
      if (this.bindingService === service) this.bindingService = null;
    };
  }

  onChange(listener) {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  emit(change) {
    for (const listener of this.projectListeners) listener(change);
  }

  normalizeRoots(roots) {
    if (!Array.isArray(roots) || roots.length === 0) throw new Error("project roots must not be empty");
    return [...new Set(roots.map((root) => normalizedPath(root?.path)))].map((path) => ({ path }));
  }

  get(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    return project;
  }

  list(params = {}) {
    const ordered = this.catalogCache ??= [...this.projects.values()]
      .sort((left, right) => left.position - right.position);
    const limit = Math.max(1, Math.min(Number(params.limit) || 100, 1000));
    const offset = params.cursor == null ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ordered.length) {
      throw new Error("invalid project/list cursor");
    }
    const data = ordered.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return { data, nextCursor: nextOffset < ordered.length ? String(nextOffset) : null };
  }

  create(params, connection, importing = false) {
    const name = String(params.name ?? "").trim();
    if (!name) throw new Error("project name must not be empty");
    const idempotencyKey = String(params.idempotencyKey ?? "").trim();
    if (!idempotencyKey) throw new Error("project idempotencyKey must not be empty");
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId && this.projects.has(existingId)) return this.projects.get(existingId);
    const now = Math.floor(Date.now() / 1000);
    const project = {
      id: `project-${uuidV7()}`,
      name,
      roots: this.normalizeRoots(params.roots),
      metadata: { ...(params.metadata ?? {}) },
      position: this.projects.size,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.idempotency.set(idempotencyKey, project.id);
    this.persist();
    this.emit({ type: "project", connection, projectId: project.id, changeType: "created" });
    if (importing) {
      for (const threadId of params.threads ?? []) {
        if (this.ctx.threadManager.find(threadId)) this.bindingService?.assign(threadId, project.id, connection);
      }
    }
    return project;
  }

  ensureExternal(projectId, cwd = null, connection = null, options = {}) {
    if (this.projects.has(projectId)) return this.projects.get(projectId);
    const now = Math.floor(Date.now() / 1000);
    const root = normalizedPath(cwd ?? "/workspace");
    const project = {
      id: projectId,
      name: projectNameFromRoot(root),
      roots: [{ path: root }],
      metadata: { origin: "desktop-projection" },
      position: this.projects.size,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    if (options.persist !== false) this.persist();
    if (options.notify !== false) {
      this.emit({ type: "project", connection, projectId: project.id, changeType: "created" });
    }
    return project;
  }

  exactRoot(root) {
    const expected = normalizedPath(root);
    return [...this.projects.values()].find((project) =>
      project.roots.some((candidate) => normalizedPath(candidate.path) === expected)) ?? null;
  }

  ensureAuthority(root, connection = null, options = {}) {
    const logicalRoot = normalizedPath(root);
    const existing = this.exactRoot(logicalRoot);
    if (existing) return existing;
    const id = authoritativeProjectId(logicalRoot);
    if (this.projects.has(id)) throw new Error(`authoritative project id collision: ${logicalRoot}`);
    const now = Math.floor(Date.now() / 1000);
    const project = {
      id,
      name: projectNameFromRoot(logicalRoot),
      roots: [{ path: logicalRoot }],
      metadata: { origin: "hypernode-authority", logicalRoot },
      position: this.projects.size,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(id, project);
    this.idempotency.set(`authority:${logicalRoot}`, id);
    if (options.persist !== false) this.persist();
    if (options.notify !== false) {
      this.emit({ type: "project", connection, projectId: id, changeType: "created" });
    }
    return project;
  }

  update(params, connection) {
    const project = this.get(params.projectId);
    if (has(params, "name")) {
      const name = String(params.name ?? "").trim();
      if (!name) throw new Error("project name must not be empty");
      project.name = name;
    }
    if (has(params, "roots")) project.roots = this.normalizeRoots(params.roots);
    if (has(params, "metadata")) project.metadata = { ...(params.metadata ?? {}) };
    project.updatedAt = Math.floor(Date.now() / 1000);
    this.persist();
    this.emit({ type: "project", connection, projectId: project.id, changeType: "updated" });
    return project;
  }

  move(params, connection) {
    const project = this.get(params.projectId);
    const ordered = [...this.projects.values()].sort((left, right) => left.position - right.position)
      .filter((candidate) => candidate.id !== project.id);
    const before = params.beforeProjectId == null
      ? ordered.length
      : ordered.findIndex((candidate) => candidate.id === params.beforeProjectId);
    ordered.splice(before < 0 ? ordered.length : before, 0, project);
    ordered.forEach((candidate, position) => { candidate.position = position; });
    this.persist();
    this.emit({ type: "project", connection, projectId: project.id, changeType: "updated" });
    return {};
  }

  delete(params, connection) {
    const project = this.get(params.projectId);
    this.projects.delete(project.id);
    this.bindingService?.clearProject(project.id, connection);
    this.persist();
    this.emit({ type: "project", connection, projectId: project.id, changeType: "deleted" });
    return {};
  }

  forCwd(cwd) {
    if (!cwd) return null;
    return [...this.projects.values()]
      .flatMap((project) => project.roots.map((root) => ({ project, length: normalizedPath(root.path).length, root })))
      .filter(({ root }) => pathContains(root.path, cwd))
      .sort((left, right) => right.length - left.length)[0]?.project ?? null;
  }

}

ProjectCatalogService.inject = ["appServer", "principal", "threadManager"];
