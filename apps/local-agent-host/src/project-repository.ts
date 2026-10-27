import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Project, ProjectCreateParams, ProjectListParams } from "@opencraft/appserver-protocol/generated/v2";
import { locked, readJson, writeJson } from "./model-config/json-file.js";

interface ProjectDocument {
  schemaVersion: 1;
  projects: Project[];
  requests: Record<string, { projectId: string; fingerprint: string }>;
}

/** Product catalog: no engine workspace identity or inference dependency. */
export class ProjectRepository {
  readonly path: string | null;
  private memory: ProjectDocument = { schemaVersion: 1, projects: [], requests: {} };
  private pending: Promise<unknown> = Promise.resolve();

  constructor(directory?: string) {
    this.path = directory ? join(directory, "projects.json") : null;
  }

  private async read(): Promise<ProjectDocument> {
    if (!this.path) return structuredClone(this.memory);
    const raw = await readJson(this.path);
    if (raw === null) return { schemaVersion: 1, projects: [], requests: {} };
    const doc = raw as ProjectDocument;
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.projects)
      || !doc.requests || typeof doc.requests !== "object" || Array.isArray(doc.requests)
      || doc.projects.some(p => !p || typeof p.id !== "string" || typeof p.name !== "string"
        || !Array.isArray(p.roots) || !p.roots.length || p.roots.some(r => typeof r?.path !== "string" || !isAbsolute(r.path))
        || !p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata) || Object.values(p.metadata).some(v => typeof v !== "string")
        || !Number.isFinite(p.createdAt) || !Number.isFinite(p.updatedAt) || !Number.isFinite(p.position)
        || (p.recencyAt !== undefined && p.recencyAt !== null && !Number.isFinite(p.recencyAt)))
      || new Set(doc.projects.map(p => p.id)).size !== doc.projects.length
      || Object.values(doc.requests).some(r => !r || typeof r.fingerprint !== "string" || !doc.projects.some(p => p.id === r.projectId))) {
      throw new Error("Project storage is invalid; original file was not overwritten");
    }
    return {
      ...doc,
      projects: doc.projects.map(project => ({
        ...project,
        recencyAt: project.recencyAt ?? null,
      })),
    };
  }

  async list(params: ProjectListParams = {}) {
    const doc = await this.read();
    const offset = params.cursor ? Number(params.cursor) : 0;
    const limit = params.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid project pagination");
    const data = doc.projects.slice(offset, offset + limit);
    return { data, nextCursor: offset + data.length < doc.projects.length ? String(offset + data.length) : null };
  }

  async create(params: ProjectCreateParams): Promise<{ project: Project }> {
    if (!params || typeof params.name !== "string" || !params.name.trim()
      || typeof params.idempotencyKey !== "string" || !params.idempotencyKey || params.idempotencyKey.length > 4096
      || !Array.isArray(params.roots) || !params.roots.length
      || params.roots.some(r => typeof r?.path !== "string" || !isAbsolute(r.path))
      || (params.metadata != null && (typeof params.metadata !== "object" || Array.isArray(params.metadata) || Object.values(params.metadata).some(v => typeof v !== "string")))) {
      throw new Error("Invalid project configuration");
    }
    const roots = [...new Set(params.roots.map(r => resolve(r.path)))].map(path => ({ path }));
    const fingerprint = JSON.stringify(roots);
    // Validate on the Host that owns these paths, never on a remote renderer.
    for (const root of roots) if (!(await stat(root.path)).isDirectory()) throw new Error("Project root must be a directory");
    const operation = async () => {
      const doc = await this.read();
      const prior = Object.hasOwn(doc.requests, params.idempotencyKey) ? doc.requests[params.idempotencyKey] : undefined;
      if (prior && prior.fingerprint !== fingerprint) throw new Error("Project idempotency key was reused for another directory");
      let project = doc.projects.find(p => p.id === prior?.projectId || JSON.stringify(p.roots) === fingerprint);
      if (!project) {
        const now = Math.floor(Date.now() / 1000);
        project = { id: randomUUID(), name: params.name.trim() || basename(roots[0]!.path), roots,
          metadata: { ...params.metadata }, position: doc.projects.length, createdAt: now, updatedAt: now, recencyAt: null };
        doc.projects.push(project);
      }
      Object.defineProperty(doc.requests, params.idempotencyKey, { value: { projectId: project.id, fingerprint }, enumerable: true, configurable: true, writable: true });
      if (this.path) await writeJson(this.path, doc); else this.memory = doc;
      return { project: structuredClone(project) };
    };
    const result = this.pending.then(() => this.path ? locked(this.path, operation) : operation());
    this.pending = result.catch(() => undefined);
    return result;
  }
}
