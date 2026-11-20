import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { digest, stable } from "../../domain/values.mjs";
import { normalizeMemory } from "../../domain/memory-synthesis.mjs";
import { memoryKey } from "../../domain/memory-recall.mjs";
import {
  memoryProjectSlug,
  projectGrantId,
  projectGrantBinding,
} from "../../domain/memory-spaces.mjs";

export const fileContentId = (value) =>
  createHash("sha1")
    .update(normalizeMemory(value).toLowerCase())
    .digest("hex")
    .slice(0, 16);
const safeId = (id) => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))
    throw new Error("Unsafe memory agent id");
  return id;
};
const day = (at) =>
  at ? new Date(at).toISOString().slice(0, 10) : "0000-00-00";
export class MemoryFileStore {
  constructor(profile, {readOnly = false} = {}) {
    this.readOnly = readOnly;
    this.profile = profile;
    this.agentId = safeId(profile.config.assistantId);
    this.owner = profile.config.owner;
    this.botLayout = profile.config.layout === "bot-v1";
    this.ownerPath = this.botLayout ? "memory/.owner.json" : "owner.json";
    this.agentPath = this.botLayout
      ? "memory/.identity.json"
      : `agents/${this.agentId}/agent.json`;
    this.membershipPath = `agents/${this.agentId}/projects.json`;
    const root = resolve(
      this.botLayout
        ? profile.path
        : (profile.config.memoryRoot ?? join(profile.path, "memory-space")),
    );
    if (!readOnly) mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    this.staged = new Map();
    // Authority initializes metadata while holding the same root lock as writes.
  }
  safe(name) {
    if (
      typeof name !== "string" ||
      name.includes("\\") ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      name.includes("\0")
    )
      throw new Error("Unsafe memory path");
    const path = join(this.root, name);
    let at = this.root;
    for (const part of name.split("/")) {
      at = join(at, part);
      if (existsSync(at) && lstatSync(at).isSymbolicLink())
        throw new Error("Memory symlinks are forbidden");
    }
    if (relative(this.root, path).startsWith(".."))
      throw new Error("Memory path escaped root");
    return path;
  }
  read(name, overlay = true, maxBytes = 8 * 1024 * 1024) {
    if (overlay && this.staged.has(name)) return this.staged.get(name);
    const path = this.safe(name);
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Invalid or oversized memory file");
      if (realpathSync(`/proc/self/fd/${fd}`) !== path)
        throw new Error("Memory file path changed");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  atomic(name, text) {
    if(this.readOnly) throw Error("Read-only memory store");
    const path = this.safe(name);
    if (text === null) {
      try {
        unlinkSync(path);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.safe(name);
    const temp = `${path}.tmp-${randomUUID()}`;
    let fd;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, text);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
      const dirfd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirfd);
      } finally {
        closeSync(dirfd);
      }
    } finally {
      if (fd !== null && fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  json(name, fallback = null) {
    const raw = this.read(name);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Malformed memory metadata: ${name}`);
    }
  }
  initialize() {
    if(this.readOnly) throw Error("Read-only memory store");
    const claim = this.json(this.ownerPath);
    if (claim && claim.owner !== this.owner)
      throw new Error("Memory root belongs to another owner");
    if (!claim) {
      const temp = `.owner-${randomUUID()}.tmp`;
      this.atomic(temp, stable({ schema: 1, owner: this.owner }) + "\n");
      try {
        try {
          linkSync(this.safe(temp), this.safe(this.ownerPath));
          const fd = openSync(this.root, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (this.json(this.ownerPath)?.owner !== this.owner)
            throw new Error("Memory root belongs to another owner");
        }
      } finally {
        this.atomic(temp, null);
      }
    }

    const path = this.agentPath,
      agent = this.json(path);
    if (agent && (agent.id !== this.agentId || agent.owner !== this.owner))
      throw new Error("Memory agent identity differs");
    if (!agent)
      this.atomic(
        path,
        stable({
          id: this.agentId,
          owner: this.owner,
          name: this.profile.config.assistantName ?? this.agentId,
        }) + "\n",
      );
    if (!this.botLayout && this.read(this.membershipPath) === null)
      this.atomic(
        this.membershipPath,
        stable({ projects: [], grants: {} }) + "\n",
      );
  }
  directories(name) {
    const path = this.safe(name);
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    if (entries.length > 512)
      throw new Error("Memory directory exceeds scan limit");
    if (entries.some((e) => e.isSymbolicLink()))
      throw new Error("Memory symlinks are forbidden");
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }
  files(name) {
    const path = this.safe(name);
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    if (entries.length > 2048 || entries.some((e) => e.isSymbolicLink()))
      throw new Error("Invalid memory directory");
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  }
  shard(scope, projectId = null, agentId = this.agentId) {
    safeId(agentId);
    if (this.botLayout) {
      if (scope !== "agent" || agentId !== this.agentId)
        throw Error("Bot private memory cannot access another scope or writer");
      return "memory";
    }
    if (scope === "agent") return `agents/${agentId}/memory`;
    if (scope === "user") return `user-memory/agents/${agentId}`;
    if (scope !== "project") throw new Error("Unknown memory scope");
    if (!/^[a-f0-9]{64}$/.test(projectId ?? "")) memoryProjectSlug(projectId);
    return `projects/${projectId}/memory/agents/${agentId}`;
  }
  membership() {
    if (this.botLayout) return { projects: [], grants: {} };
    const m = this.json(this.membershipPath);
    if (
      !m ||
      !Array.isArray(m.projects) ||
      m.projects.length > 128 ||
      !m.grants ||
      typeof m.grants !== "object"
    )
      throw new Error("Invalid memory project membership");
    for (const slug of m.projects) {
      memoryProjectSlug(slug);
      if (typeof m.grants[slug] !== "string")
        throw new Error("Invalid memory project grant");
    }
    return m;
  }
  project(slug) {
    if (!/^[a-f0-9]{64}$/.test(slug ?? "")) memoryProjectSlug(slug);
    const p = this.json(`projects/${slug}/identity.json`);
    if (!p) return null;
    if (
      p.slug !== slug ||
      typeof p.id !== "string" ||
      typeof p.name !== "string"
    )
      throw new Error("Invalid memory project identity");
    return p;
  }
  resources() {
    const m = this.membership();
    return m.projects.flatMap((slug) => {
      const p = this.project(slug);
      return p
        ? [
            {
              id: projectGrantId(slug),
              binding: projectGrantBinding(p.id, m.grants[slug]),
            },
          ]
        : [];
    });
  }
  projects() {
    const m = this.membership();
    return m.projects.map((slug) => {
      const p = this.project(slug);
      return { slug, name: p?.name ?? slug, exists: !!p };
    });
  }
  stageProject(action, { slug, name, description = "" }) {
    if (this.botLayout)
      throw Error("Shared memory requires an explicit platform space binding");
    memoryProjectSlug(slug);
    let p = this.project(slug);
    const m = this.membership();
    if (action === "create" && !p) {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 120 ||
        typeof description !== "string" ||
        description.length > 2000
      )
        throw new Error("Project needs a bounded name and description");
      p = { id: randomUUID(), slug, name: name.trim(), type: "named" };
      this.staged.set(`projects/${slug}/identity.json`, stable(p) + "\n");
      this.staged.set(
        `projects/${slug}/project.md`,
        `# ${name.trim().replace(/[\r\n]/g, " ")}\n\n${description}\n`,
      );
    }
    if (!p) throw new Error("Memory project does not exist");
    if (action === "leave") {
      m.projects = m.projects.filter((s) => s !== slug);
      delete m.grants[slug];
    } else if (!m.projects.includes(slug)) {
      m.projects.push(slug);
      m.projects.sort();
      m.grants[slug] = randomUUID();
    }
    if (m.projects.length > 128)
      throw new Error("Too many joined memory projects");
    this.staged.set(this.membershipPath, stable(m) + "\n");
    return { slug, name: p.name, joined: action !== "leave" };
  }
  scan() {
    let bytes = 0;
    const images = new Map(),
      read = (name) => {
        const raw = this.read(name);
        bytes +=
          Buffer.byteLength(raw ?? "", "utf8") -
          Buffer.byteLength(images.get(name) ?? "", "utf8");
        if (bytes > 64 * 1024 * 1024)
          throw new Error("Memory scan exceeds total byte bound");
        images.set(name, raw);
        if (images.size > 10000)
          throw new Error("Memory file count exceeds limit");
        return raw;
      };
    const json = (name, fallback) => {
      const raw = read(name);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`Malformed memory metadata: ${name}`);
      }
    };
    read(this.ownerPath);
    if (!this.botLayout) read(this.membershipPath);
    const members = this.membership(),
      projects = (this.botLayout ? [] : this.directories("projects"))
        .map((id) => this.project(id))
        .filter(Boolean),
      rows = [],
      tombstones = [],
      refreshes = [];
    const names = new Map();
    for (const id of this.botLayout
      ? [this.agentId]
      : this.directories("agents")) {
      safeId(id);
      const agent = json(
        this.botLayout ? this.agentPath : `agents/${id}/agent.json`,
        null,
      );
      if (agent) names.set(id, String(agent.name ?? id).slice(0, 120));
    }
    const add = (scope, projectId, agentId) => {
      const dir = this.shard(scope, projectId, agentId),
        metadata = json(`${dir}/.dreaming/records.json`, { records: [] });
      if (!Array.isArray(metadata.records) || metadata.records.length > 10000)
        throw new Error("Invalid memory record metadata");
      if (
        metadata.records.some(
          (r) =>
            !r ||
            typeof r.key !== "string" ||
            !Number.isSafeInteger(r.revision) ||
            r.revision < 1 ||
            !Number.isSafeInteger(r.updatedAt) ||
            r.updatedAt < 0 ||
            typeof r.input_id !== "string" ||
            typeof r.deleted !== "boolean" ||
            !["profile", "log"].includes(r.kind) ||
            !["explicit", "automatic", "legacy"].includes(r.origin) ||
            (r.contentId !== null && !/^[a-f0-9]{16}$/.test(r.contentId)) ||
            !Array.isArray(r.evidenceIds) ||
            r.evidenceIds.length > 32 ||
            r.evidenceIds.some((id) => typeof id !== "string"),
        )
      )
        throw new Error("Invalid memory record metadata");
      const records = metadata.records,
        used = new Set(),
        seen = new Set();
      const parse = (path, kind) => {
        const raw = read(path);
        if (raw === null) return;
        for (const text of raw.split("\n")) {
          const m = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/.exec(text);
          if (!m) continue;
          const value = normalizeMemory(m[2]),
            id = fileContentId(value);
          if (seen.has(id)) continue;
          seen.add(id);
          const record = records.find(
              (r) => !r.deleted && r.contentId === id && r.kind === kind,
            ),
            sourceKey =
              record?.key ?? memoryKey(`fact_${id}`, scope, projectId);
          if (memoryKey(sourceKey, scope, projectId) !== sourceKey)
            throw new Error("Memory metadata key escapes its shard");
          if (record) used.add(record.key);
          const explicit =
              read(`${dir}/.dreaming/explicit/${id}.memory`) !== null,
            automatic =
              read(`${dir}/.dreaming/synthesized/${id}.memory`) !== null;
          const at = Date.parse(`${m[1]}T00:00:00Z`),
            updatedAt =
              record && day(record.updatedAt) === m[1]
                ? record.updatedAt
                : Number.isFinite(at)
                  ? at
                  : 0;
          rows.push({
            key:
              agentId === this.agentId
                ? sourceKey
                : `@shared/${agentId}/${digest([scope, projectId, sourceKey]).slice(0, 32)}`,
            value,
            revision: record?.revision ?? 1,
            input_id: record?.input_id ?? "file-edit",
            deleted: 0,
            scope,
            projectId,
            kind,
            updatedAt,
            origin: explicit ? "explicit" : automatic ? "automatic" : "legacy",
            evidenceIds: record?.evidenceIds ?? [],
            agentId,
            agentName: names.get(agentId) ?? agentId,
            contentId: id,
            path,
          });
        }
      };
      parse(`${dir}/profile.md`, "profile");
      for (const name of this.files(`${dir}/log`)) {
        if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
        parse(`${dir}/log/${name}`, "log");
      }
      if (agentId === this.agentId) {
        for (const r of records) {
          if (used.has(r.key)) continue;
          if (memoryKey(r.key, scope, projectId) !== r.key)
            throw new Error("Invalid memory record key");
          rows.push({
            ...r,
            value: "",
            deleted: 1,
            revision: r.revision + (r.deleted ? 0 : 1),
            scope,
            projectId,
            agentId,
            agentName: names.get(agentId) ?? agentId,
            path: null,
            origin: r.origin ?? "legacy",
            evidenceIds: r.evidenceIds ?? [],
          });
        }
        for (const name of this.files(`${dir}/.dreaming/tombstones`)) {
          if (!/^[a-f0-9]{64}\.deleted$/.test(name))
            throw new Error("Invalid memory tombstone");
          read(`${dir}/.dreaming/tombstones/${name}`);
          tombstones.push({
            id: name.slice(0, -8),
            scope,
            project_id: projectId,
            content: "",
            created_at: 0,
          });
        }
        const refresh = read(`${dir}/.dreaming/next-refresh-at`);
        if (refresh !== null) {
          const n = Number(refresh.trim());
          if (!Number.isSafeInteger(n) || n < 0)
            throw new Error("Invalid temporal refresh marker");
          refreshes.push({
            scope:
              scope === "project"
                ? `@project/${projectId}`
                : scope === "agent"
                  ? "agent"
                  : "user",
            next_at: n,
          });
        }
      }
    };
    add("agent", null, this.agentId);
    const users = new Set([
      ...(this.botLayout ? [] : this.directories("user-memory/agents")),
      this.agentId,
    ]);
    if (!this.botLayout) for (const id of users) add("user", null, id);
    for (const p of projects) {
      read(`projects/${p.slug}/identity.json`);
      read(`projects/${p.slug}/project.md`);
      const ids = new Set([
        this.agentId,
        ...(members.projects.includes(p.slug)
          ? this.directories(`projects/${p.slug}/memory/agents`)
          : []),
      ]);
      for (const id of ids) add("project", p.slug, id);
    }
    if (rows.length > 10000) throw new Error("Memory fact count exceeds limit");
    return {
      rows,
      tombstones,
      refreshes,
      images,
      fingerprint: digest([...images].sort(([a], [b]) => a.localeCompare(b))),
      projects,
    };
  }
  stageRecords(before, after, tombstones, refreshes) {
    const ownBefore = before.filter((r) => r.agentId === this.agentId),
      ownAfter = after.filter((r) => !r.agentId || r.agentId === this.agentId),
      groups = new Map();
    for (const r of [...ownBefore, ...ownAfter])
      groups.set(this.shard(r.scope, r.projectId), {
        scope: r.scope,
        projectId: r.projectId,
      });
    for (const [dir, scope] of groups) {
      const previous = ownBefore.filter(
          (r) => this.shard(r.scope, r.projectId) === dir,
        ),
        next = ownAfter.filter((r) => this.shard(r.scope, r.projectId) === dir);
      if (
        stable(
          previous.map((r) => [
            r.key,
            r.value,
            r.revision,
            r.deleted,
            r.kind,
            r.updatedAt,
            r.origin,
            r.evidenceIds,
          ]),
        ) ===
        stable(
          next.map((r) => [
            r.key,
            r.value,
            r.revision,
            r.deleted,
            r.kind,
            r.updatedAt,
            r.origin,
            r.evidenceIds,
          ]),
        )
      )
        continue;
      if (scope.scope === "project" && !this.project(scope.projectId)) {
        const p = {
          id: randomUUID(),
          slug: scope.projectId,
          name: scope.projectId,
          type: "workspace",
          binding: scope.projectId,
        };
        this.staged.set(
          `projects/${scope.projectId}/identity.json`,
          stable(p) + "\n",
        );
        this.staged.set(
          `projects/${scope.projectId}/project.md`,
          `# Workspace ${scope.projectId}\n`,
        );
      }
      const records = [];
      for (const r of next) {
        const old = previous.find((p) => p.key === r.key),
          id = r.deleted
            ? (old?.contentId ?? r.contentId ?? null)
            : fileContentId(r.value);
        if (
          !old ||
          stable([old.value, old.deleted, old.kind, old.updatedAt]) !==
            stable([r.value, !!r.deleted ? 1 : 0, r.kind, r.updatedAt])
        ) {
          if (old && !old.deleted) {
            const raw = this.staged.has(old.path)
              ? this.staged.get(old.path)
              : this.read(old.path);
            if (raw !== null)
              this.staged.set(
                old.path,
                raw
                  .split("\n")
                  .filter((line) => {
                    const m = /^-\s+\(\d{4}-\d{2}-\d{2}\)\s+(.+?)\s*$/.exec(
                      line,
                    );
                    return !m || fileContentId(m[1]) !== old.contentId;
                  })
                  .join("\n"),
              );
          }
          if (!r.deleted) {
            const path =
                r.kind === "profile"
                  ? `${dir}/profile.md`
                  : `${dir}/log/${r.updatedAt ? day(r.updatedAt).slice(0, 7) : "0000-00"}.md`,
              raw =
                this.read(path) ??
                (r.kind === "profile"
                  ? "# About the user\n\n"
                  : "# Memory log\n\n");
            this.staged.set(
              path,
              `${raw}${raw.endsWith("\n") ? "" : "\n"}- (${day(r.updatedAt)}) ${normalizeMemory(r.value)}\n`,
            );
          }
        }
        if (old?.contentId && old.contentId !== id) {
          this.staged.set(
            `${dir}/.dreaming/explicit/${old.contentId}.memory`,
            null,
          );
          this.staged.set(
            `${dir}/.dreaming/synthesized/${old.contentId}.memory`,
            null,
          );
        }
        if (id) {
          this.staged.set(
            `${dir}/.dreaming/explicit/${id}.memory`,
            !r.deleted && r.origin === "explicit" ? "" : null,
          );
          this.staged.set(
            `${dir}/.dreaming/synthesized/${id}.memory`,
            !r.deleted && r.origin === "automatic" ? "" : null,
          );
        }
        records.push({
          key: r.key,
          revision: r.revision,
          input_id: r.input_id,
          deleted: !!r.deleted,
          kind: r.kind,
          updatedAt: r.updatedAt,
          contentId: id,
          origin: r.origin ?? "legacy",
          evidenceIds: r.evidenceIds ?? [],
        });
      }
      this.staged.set(
        `${dir}/.dreaming/records.json`,
        stable({ records }) + "\n",
      );
    }
    const oldMarkerPaths = new Set();
    for (const [dir] of groups)
      for (const n of this.files(`${dir}/.dreaming/tombstones`))
        oldMarkerPaths.add(`${dir}/.dreaming/tombstones/${n}`);
    for (const t of tombstones) {
      const path = `${this.shard(t.scope, t.project_id)}/.dreaming/tombstones/${t.id}.deleted`;
      oldMarkerPaths.delete(path);
      this.staged.set(path, "");
    }
    for (const path of oldMarkerPaths) this.staged.set(path, null);
    for (const f of refreshes) {
      const scope =
          f.scope === "user" || f.scope === "agent" ? f.scope : "project",
        project =
          scope === "project" ? f.scope.replace(/^@project\//, "") : null;
      this.staged.set(
        `${this.shard(scope, project)}/.dreaming/next-refresh-at`,
        `${f.next_at}\n`,
      );
    }
  }
  locations() {
    if (this.botLayout)
      return {
        root: this.root,
        agent: this.safe("memory"),
        user: null,
        projects: null,
      };
    return {
      root: this.root,
      agent: this.safe(this.shard("agent")),
      user: this.safe(this.shard("user")),
      projects: this.safe("projects"),
    };
  }
}
