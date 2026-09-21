import { Service } from "@deepseek-ai/cordis";
import { isThreadCatalogCheckpoint } from "./thread-catalog-checkpoint.ts";
import { inferAuthoritativeProjectRoot } from "./project-catalog.js";
import { canonicalWorkspaceCwd } from "./workspace-view.js";

const INITIAL_BINDING_REPLAY_LIMIT = 1000;
export const LEGACY_PROJECT_HYDRATION_GRACE_MS = 250;

function bootstrapState(connection) {
  return connection?.projectBootstrap ?? null;
}

export class ProjectProjectionService extends Service {
  constructor(ctx) {
    super(ctx, "projectProjection");
    this.ctx = ctx;
    ctx.effect(() => ctx.projectCatalog.onChange((event) => this.onProject(event)));
    ctx.effect(() => ctx.threadProjectBinding.onChange((event) => this.onBinding(event)));
    ctx.effect(() => ctx.appServer.onInitialize((connection) => this.initialize(connection)));
    ctx.effect(() => ctx.appServer.onAfterResponse((connection, message, result) =>
      this.afterResponse(connection, message, result)));
    ctx.effect(() => ctx.appServer.projectOutbound((message, connection) =>
      this.projectMessage(message, connection)));
    ctx.effect(() => ctx.appServer.intercept((message, connection) => {
      if (message == null) this.poll(connection);
      else this.observeRequest(connection, message);
      return false;
    }));
  }

  notify(connection, method, params) {
    if (connection) this.ctx.appServer.notifyAllAfter(connection, method, params);
    else this.ctx.appServer.broadcastNotification(method, params);
  }

  onProject(event) {
    this.notify(event.connection, "project/changed", {
      projectId: event.projectId,
      changeType: event.changeType,
    });
    // A project created or mutated by this connection is already known to that
    // client once the request completes. Mark it hydrated immediately so a
    // following thread/start can return the canonical projectId instead of
    // degrading its own newly-created project to the legacy projectless view.
    // Queue the entity invalidation before any dependent binding replay.
    if (event.connection && event.changeType !== "deleted") {
      this.hydrateProjects(event.connection, [event.projectId], "project-mutation");
    }
  }

  onBinding(event) {
    const params = { threadId: event.threadId, projectId: event.projectId };
    for (const connection of this.ctx.appServer.connections ?? []) {
      if (!connection.initialized) continue;
      if (event.projectId == null || this.projectReady(connection, event.projectId)) {
        if (connection === event.connection) {
          this.ctx.appServer.notifyAfter(connection, "thread/project/updated", params);
        } else {
          this.ctx.appServer.send(connection, { method: "thread/project/updated", params });
        }
      }
    }
  }

  initialize(connection) {
    connection.projectBootstrap = {
      phase: "awaiting-catalog",
      projectsAnnounced: false,
      projectsAnnouncedAtMs: null,
      catalogHydrated: false,
      bindingsReplayed: false,
      hydratedProjectIds: new Set(),
      replayedProjectIds: new Set(),
      mode: null,
    };
  }

  projectReady(connection, projectId) {
    const state = bootstrapState(connection);
    if (!state || projectId == null) return projectId == null;
    return state.catalogHydrated || state.hydratedProjectIds.has(projectId);
  }

  projectThread(connection, thread) {
    if (!thread || typeof thread !== "object" || typeof thread.id !== "string") return thread;
    const canonical = this.ctx.threadManager.find?.(thread.id);
    const projectId = thread.projectId ?? canonical?.projectId ?? null;
    const cwd = typeof thread.cwd === "string" ? canonicalWorkspaceCwd(thread.cwd) : thread.cwd;
    const projected = cwd !== thread.cwd ? { ...thread, cwd } : thread;
    if (projectId == null || this.projectReady(connection, projectId)) return projected;
    // A project id without its parent Project entity is a dangling foreign key
    // in legacy Desktop builds. Those builds hide the whole thread. Preserve
    // canonical server ownership and degrade only this connection's wire view
    // to an unassigned thread until the client proves it knows the project.
    return { ...projected, projectId: null };
  }

  projectMessage(message, connection) {
    if (!message || typeof message !== "object" || !connection) return message;
    let projected = message;
    if (Array.isArray(message.result?.data)) {
      const data = message.result.data.map((item) => this.projectThread(connection, item));
      if (data.some((item, index) => item !== message.result.data[index])) {
        projected = { ...projected, result: { ...message.result, data } };
      }
    }
    if (message.result?.thread) {
      const thread = this.projectThread(connection, message.result.thread);
      if (thread !== message.result.thread) {
        projected = { ...projected, result: { ...projected.result, thread } };
      }
    }
    if (message.params?.thread) {
      const thread = this.projectThread(connection, message.params.thread);
      if (thread !== message.params.thread) {
        projected = { ...projected, params: { ...message.params, thread } };
      }
    }
    return projected;
  }

  observeRequest(connection, message) {
    const state = bootstrapState(connection);
    if (!state || state.catalogHydrated) return false;
    const candidates = [message.params?.cwd, message.params?.path]
      .filter((value) => typeof value === "string");
    for (const value of candidates) {
      const root = inferAuthoritativeProjectRoot(value);
      if (!root) continue;
      const project = this.ctx.projectCatalog.exactRoot?.(root);
      if (project) return this.hydrateProjects(connection, [project.id], "observed-project-root");
    }
    return false;
  }

  hydrateProjects(connection, projectIds, mode) {
    const state = bootstrapState(connection);
    if (!state) return false;
    let changed = false;
    for (const projectId of projectIds) {
      if (typeof projectId !== "string" || state.hydratedProjectIds.has(projectId)) continue;
      state.hydratedProjectIds.add(projectId);
      changed = true;
    }
    if (!changed) return false;
    this.replayBindings(connection, mode, new Set(projectIds));
    return true;
  }

  announceProjects(connection, now = Date.now()) {
    const state = bootstrapState(connection);
    if (!state || state.projectsAnnounced || state.catalogHydrated) return false;
    for (const project of this.ctx.projectCatalog.list({ limit: 1000 }).data) {
      this.ctx.appServer.notifyAfter(connection, "project/changed", {
        projectId: project.id,
        changeType: "created",
      });
    }
    state.projectsAnnounced = true;
    state.projectsAnnouncedAtMs = now;
    // A concrete project root may be observed before the first thread/list
    // response. Announcing invalidations must not regress that already-ready
    // connection back into the legacy grace state.
    state.phase = state.hydratedProjectIds.size > 0 ? "ready" : "awaiting-project-hydration";
    return true;
  }

  bindingSnapshot() {
    return this.ctx.threadManager.list({ archived: false })
      .filter((thread) => thread.projectId)
      .sort((left, right) => (right.recencyAt ?? right.updatedAt ?? 0) - (left.recencyAt ?? left.updatedAt ?? 0))
      .slice(0, INITIAL_BINDING_REPLAY_LIMIT);
  }

  replayBindings(connection, mode, projectIds = null) {
    const state = bootstrapState(connection);
    if (!state) return false;
    const bindings = this.bindingSnapshot().filter((thread) =>
      (projectIds == null || projectIds.has(thread.projectId)) &&
      !state.replayedProjectIds.has(thread.projectId));
    for (const thread of bindings) {
      this.ctx.appServer.notifyAfter(connection, "thread/project/updated", {
        threadId: thread.id,
        projectId: thread.projectId,
      });
      state.replayedProjectIds.add(thread.projectId);
    }
    state.bindingsReplayed = state.catalogHydrated;
    state.mode = mode;
    state.phase = "ready";
    this.ctx.appServer.audit?.(connection, "project_bootstrap.ready", {
      mode,
      projectCount: this.ctx.projectCatalog.list({ limit: 1000 }).data.length,
      bindingCount: bindings.length,
    });
    return true;
  }

  afterResponse(connection, message, result, now = Date.now()) {
    const state = bootstrapState(connection);
    if (!state || state.bindingsReplayed) return;

    if (message.method === "project/list") {
      // A paged catalog is authoritative only after the final page has crossed
      // the wire. AppServer invokes this hook after sending the response.
      if (result?.nextCursor == null) {
        state.catalogHydrated = true;
        for (const project of this.ctx.projectCatalog.list({ limit: 1000 }).data) {
          state.hydratedProjectIds.add(project.id);
        }
        state.phase = "catalog-hydrated";
        this.replayBindings(connection, "authoritative-project-list");
      }
      return;
    }

    if (message.method === "thread/list" && isThreadCatalogCheckpoint(message.params ?? {})) {
      // Initializing notifications race the Desktop subscription graph. The
      // first root thread catalog response is the earliest reliable point at
      // which a cold client can observe project invalidations.
      this.announceProjects(connection, now);
    }
  }

  poll(connection, now = Date.now()) {
    const state = bootstrapState(connection);
    if (!state || state.catalogHydrated || !state.projectsAnnounced) return false;
    if (state.phase !== "awaiting-project-hydration") return false;
    if (now - state.projectsAnnouncedAtMs < LEGACY_PROJECT_HYDRATION_GRACE_MS) return false;
    if (state.mode === "legacy-catalog-bootstrap") return false;
    // Desktop versions that do not opt into the experimental project/list API
    // still build their remote project view from canonical thread cwd values.
    // Treat HyperNode's catalog as authoritative after the invalidation grace
    // window and replay the stable bindings. Keeping these clients permanently
    // projectless makes a fresh installation depend on local project state.
    state.catalogHydrated = true;
    for (const project of this.ctx.projectCatalog.list({ limit: 1000 }).data) {
      state.hydratedProjectIds.add(project.id);
    }
    this.replayBindings(connection, "legacy-catalog-bootstrap");
    this.ctx.appServer.audit?.(connection, "project_bootstrap.compatible", {
      mode: state.mode,
      projectCount: this.ctx.projectCatalog.list({ limit: 1000 }).data.length,
    });
    return true;
  }
}

ProjectProjectionService.inject = ["appServer", "projectCatalog", "threadManager", "threadProjectBinding"];
