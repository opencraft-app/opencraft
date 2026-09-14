import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection, AppServerParams } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  ProjectBindingCatalogPort,
  ThreadLifecycleThread,
  ThreadProjectBindingChange,
  ThreadProjectBindingLifecyclePort,
} from "../types/thread-lifecycle.ts";
import { inferAuthoritativeProjectRoot } from "./project-catalog.js";

type Dependencies = "projectCatalog" | "threadManager";

interface BindingOptions {
  forceNotify?: boolean;
  inferWhenNull?: boolean;
}

function has(object: unknown, key: PropertyKey): boolean {
  return typeof object === "object" && object !== null &&
    Object.prototype.hasOwnProperty.call(object, key);
}

function normalizedPath(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export class ThreadProjectBindingService extends Service implements
  ThreadProjectBindingLifecyclePort,
  ProjectBindingCatalogPort {
  static inject = ["projectCatalog", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly listeners = new Set<(change: ThreadProjectBindingChange) => void>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadProjectBinding");
    ctx.effect(() => ctx.projectCatalog.attachBindingService(this));
    this.migrate();
  }

  onChange(listener: (change: ThreadProjectBindingChange) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change: ThreadProjectBindingChange): void {
    for (const listener of this.listeners) listener(change);
  }

  allThreads(): ThreadLifecycleThread[] {
    return [
      ...this.ctx.threadManager.list({ archived: false }),
      ...this.ctx.threadManager.list({ archived: true }),
    ];
  }

  migrate(): void {
    const assignments: Array<[string, string]> = [];
    let projectCatalogChanged = false;
    for (const thread of this.allThreads()) {
      if (thread.projectId) {
        if (!this.ctx.projectCatalog.projects.has(thread.projectId)) {
          this.ctx.projectCatalog.ensureExternal(thread.projectId, thread.cwd, null, {
            notify: false,
            persist: false,
          });
          projectCatalogChanged = true;
        }
        continue;
      }
      const root = inferAuthoritativeProjectRoot(thread.cwd);
      if (!root) continue;
      const before = this.ctx.projectCatalog.projects.size;
      const project = this.ctx.projectCatalog.ensureAuthority(root, null, {
        notify: false,
        persist: false,
      });
      projectCatalogChanged ||= this.ctx.projectCatalog.projects.size !== before;
      assignments.push([thread.id, project.id]);
    }
    if (projectCatalogChanged) this.ctx.projectCatalog.persist();
    if (assignments.length > 0) {
      for (const [threadId, projectId] of assignments) {
        this.ctx.threadManager.setProject(threadId, projectId, { persist: false, touch: false });
      }
      this.ctx.threadManager.persist();
      console.info(`[project-binding] migrated authoritative assignments=${assignments.length}`);
    }
  }

  capture(
    thread: ThreadLifecycleThread,
    params: AppServerParams = {},
    connection: AppServerConnection | null = null,
    options: BindingOptions = {},
  ): ThreadLifecycleThread {
    if (has(params, "projectId") && (params["projectId"] || options.inferWhenNull !== true)) {
      const projectId = typeof params["projectId"] === "string" && params["projectId"]
        ? params["projectId"]
        : null;
      if (projectId) {
        const cwd = typeof params["cwd"] === "string" ? params["cwd"] : thread.cwd;
        this.ctx.projectCatalog.ensureExternal(projectId, cwd, connection);
      }
      return this.assign(thread.id, projectId, connection, options);
    }
    const existing = this.ctx.projectCatalog.forCwd(thread.cwd);
    const root = inferAuthoritativeProjectRoot(thread.cwd);
    const project = existing ?? (root
      ? this.ctx.projectCatalog.ensureAuthority(root, connection)
      : null);
    if (!project) return thread;
    return this.assign(thread.id, project.id, connection, options);
  }

  observeList(params: AppServerParams = {}, connection: AppServerConnection | null = null): void {
    if (typeof params["projectId"] !== "string") return;
    const cwdParam = params["cwd"];
    const cwds = Array.isArray(cwdParam)
      ? cwdParam.filter((cwd): cwd is string => typeof cwd === "string")
      : typeof cwdParam === "string" && cwdParam ? [cwdParam] : [];
    const project = this.ctx.projectCatalog.ensureExternal(
      params["projectId"],
      cwds[0] ?? "/workspace",
      connection,
    );
    if (cwds.length === 0) return;
    const roots = this.ctx.projectCatalog.normalizeRoots(cwds.map((path) => ({ path })));
    if (JSON.stringify(project.roots) !== JSON.stringify(roots)) {
      project.roots = roots;
      project.updatedAt = Math.floor(Date.now() / 1000);
      this.ctx.projectCatalog.persist();
      this.ctx.projectCatalog.emit({
        type: "project",
        connection,
        projectId: project.id,
        changeType: "updated",
      });
    }
    this.assignMany(
      this.ctx.threadManager.list({ archived: false })
        .filter((thread) => cwds.some((cwd) =>
          normalizedPath(cwd) === normalizedPath(thread.cwd)))
        .map((thread) => thread.id),
      project.id,
      connection,
    );
  }

  assignMany(
    threadIds: readonly string[],
    projectId: string | null,
    connection: AppServerConnection | null = null,
  ): string[] {
    if (projectId) this.ctx.projectCatalog.get(projectId);
    const changed: string[] = [];
    for (const threadId of threadIds) {
      const thread = this.ctx.threadManager.get(threadId);
      if ((thread.projectId ?? null) === projectId) continue;
      this.ctx.threadManager.setProject(threadId, projectId, { persist: false, touch: false });
      changed.push(threadId);
    }
    if (changed.length > 0) this.ctx.threadManager.persist();
    for (const threadId of changed) {
      this.emit({ type: "binding", connection, threadId, projectId });
    }
    return changed;
  }

  assign(
    threadId: string,
    projectId: string | null,
    connection: AppServerConnection | null = null,
    options: BindingOptions = {},
  ): ThreadLifecycleThread {
    if (projectId) this.ctx.projectCatalog.get(projectId);
    const thread = this.ctx.threadManager.get(threadId);
    const changed = (thread.projectId ?? null) !== projectId;
    this.ctx.threadManager.setProject(threadId, projectId, { touch: false });
    if (changed || options.forceNotify === true) {
      this.emit({ type: "binding", connection, threadId, projectId });
    }
    return thread;
  }

  clearProject(projectId: string, connection: AppServerConnection | null = null): void {
    this.assignMany(
      this.allThreads()
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => thread.id),
      null,
      connection,
    );
  }
}
