import {createMemoryBrowserView} from './memory-browser-view.mjs';
import { memoryView, projectGrantId } from "../domain/memory-spaces.mjs";
import {
  memoryKey,
  memoryKind,
  recallOptions,
  memoryDocument,
} from "../domain/memory-recall.mjs";
import {
  MemorySynthesisPolicy,
  normalizeMemory,
  memoryDedupe,
  memoryFactId,
  memoryTombstoneId,
  synthesisFact,
  synthesisFingerprint,
} from "../domain/memory-synthesis.mjs";
import { requireRevision, requireText } from "../domain/values.mjs";
import { MemoryEntry } from "../domain/memory-entry.mjs";

export class MemoryService {
  constructor({
    repositories: r,
    inbox,
    uow,
    scope,
    files,
    agentId,
    defaultScope = "user",
    now = Date.now,
  }) {
    Object.assign(this, {
      r,
      inbox,
      uow,
      scope,
      files,
      agentId,
      defaultScope,
      now,
    });
  }
  projectFor(resources = this.scope?.resources ?? []) {
    return (
      resources.find((r) => r.id === "materials" && this.scope?.canObserve([r]))
        ?.binding ?? null
    );
  }
  synchronize() {
    this.files?.synchronize();
  }
  filesChanged(fence = true) {
    this.r.meta.advanceMemoryEpoch();
    if (fence) this.r.meta.advanceExplicitMemoryEpoch();
    this.r.events.append("memory.files.changed", null, { fence }, this.now());
  }
  view(resources = this.scope.resources) {
    const projectId = this.projectFor(resources),
      named = resources
        .filter(
          (r) =>
            r.id.startsWith("memory.project/") &&
            this.scope.querySourceAllowed({ resources }, r),
        )
        .map((r) => r.id.slice("memory.project/".length));
    const projectNames = Object.fromEntries(
      (this.files?.projects() ?? []).map((p) => [p.slug, p.name]),
    );
    return {
      projectId,
      projectIds: [...new Set([...(projectId ? [projectId] : []), ...named])],
      projectNames,
      agentId: this.agentId,
    };
  }
  owns(row) {
    return !row?.agentId || row.agentId === this.agentId;
  }
  rebaseSnapshot(snapshot) {
    const resources = snapshot.memoryResources ?? [];
    if (resources.some((r) => !this.scope.querySourceAllowed({ resources }, r)))
      throw new Error("Memory project membership changed");
    return this.learningSnapshot(snapshot.projectId ?? null, resources);
  }
  address(params, resources) {
    const previous = this.r.memories.get(params.key);
    if (previous && !this.owns(previous))
      throw new Error("Cannot write another assistant memory shard");
    const view = this.view(resources),
      projectId = params.project ?? previous?.projectId ?? view.projectId;
    const requested = params.scope ?? previous?.scope ?? this.defaultScope;
    if (
      previous?.scope === "project" &&
      !view.projectIds.includes(previous.projectId)
    )
      throw new Error("Memory belongs to another project");
    if (requested === "project" && !view.projectIds.includes(projectId))
      throw new Error("Memory project is outside current membership/grant");
    const key =
      previous?.scope === "user" && requested === "user"
        ? params.key
        : memoryKey(params.key, requested, projectId);
    if (
      previous?.scope === "project" &&
      !view.projectIds.includes(previous.projectId)
    )
      throw new Error("Memory belongs to another project");
    return {
      key,
      scope: requested,
      projectId: requested === "project" ? projectId : null,
      kind: memoryKind(
        params.kind === "note"
          ? "log"
          : (params.kind ?? this.r.memories.get(key)?.kind),
      ),
    };
  }
  change(inputId, op, params, resources) {
    return this.inbox.accept(inputId, op, params, () => {
      const address = this.address(params, resources);
      let previous = this.r.memories.get(address.key);
      requireRevision(
        params.expectedRevision,
        previous?.revision ?? 0,
        "memory",
      );
      const forgetting = op === "memory.forget";
      const value = forgetting
        ? previous?.value
        : normalizeMemory(
            params.kind === "note" ? `Note: ${params.value}` : params.value,
          );
      // Content identity is within an authorized scope, independent of callers' keys.
      if (!forgetting) {
        const duplicate = this.r.memories
          .list(address.projectId)
          .find(
            (m) =>
              this.owns(m) &&
              m.scope === address.scope &&
              m.projectId === address.projectId &&
              memoryDedupe(m.value) === memoryDedupe(value),
          );
        if (duplicate && duplicate.key !== address.key) {
          if (previous && !previous.deleted)
            throw new Error("Memory content already exists under another key");
          previous = duplicate;
          address.key = duplicate.key;
        }
      }
      // A keyed explicit correction removes its previous content just like explicit forget+add.
      if (
        !forgetting &&
        previous &&
        !previous.deleted &&
        memoryDedupe(previous.value) !== memoryDedupe(value)
      ) {
        this.r.memories.tombstone(
          memoryTombstoneId(address.scope, address.projectId, previous.value),
          {
            ...address,
            content: normalizeMemory(previous.value),
            at: this.now(),
          },
        );
      }
      const m = MemoryEntry.change(
        previous,
        { key: address.key, value, expectedRevision: previous?.revision ?? 0 },
        inputId,
        forgetting,
      );
      if (value) {
        const tombstoneId = memoryTombstoneId(
          address.scope,
          address.projectId,
          value,
        );
        if (forgetting)
          this.r.memories.tombstone(tombstoneId, {
            ...address,
            content: normalizeMemory(value),
            at: this.now(),
          });
        else this.r.memories.clearTombstone(tombstoneId);
      }
      this.r.memories.save(m);
      this.r.memories.detail(m.key, { ...address, updatedAt: this.now() });
      // Keep original evidence on an explicit correction; never claim it is the corrected wording.
      const original = !forgetting && previous ? this.r.memories.provenance(previous.key) : null;
      this.r.memories.recordProvenance(m.key, m.revision, "explicit", original?.evidence_json ? JSON.parse(original.evidence_json) : []);
      this.r.meta.advanceMemoryEpoch();
      this.r.meta.advanceExplicitMemoryEpoch();
      this.r.events.append(
        op,
        null,
        { key: m.key, revision: m.revision },
        this.now(),
      );
      return { key: m.key, revision: m.revision, deleted: !!m.deleted };
    });
  }
  learningSnapshot(
    projectId = this.projectFor(),
    resources = this.scope.resources,
  ) {
    this.synchronize();
    if (projectId !== null && projectId !== this.projectFor())
      throw new Error("Learning project binding changed");
    const view = this.view(resources);
    view.projectId = projectId;
    view.projectIds = [
      ...new Set([...view.projectIds, ...(projectId ? [projectId] : [])]),
    ];
    const all = this.r.memories.catalog(view);
    const memories = all
      .filter((m) => this.owns(m))
      .map((m) => ({
        ...m,
        origin: this.r.memories.provenance(m.key)?.origin ?? "legacy",
      }));
    const selected = memories
      .filter((m) => !m.deleted)
      .sort(
        (a, b) =>
          Number(b.origin === "explicit") - Number(a.origin === "explicit") ||
          Number(b.kind === "profile") - Number(a.kind === "profile") ||
          b.updatedAt - a.updatedAt ||
          a.key.localeCompare(b.key),
      );
    const ids = new Set();
    const facts = selected
      .filter((m) => {
        const id = memoryFactId(m);
        if (ids.has(id)) return false;
        ids.add(id);
        return true;
      })
      .slice(0, MemorySynthesisPolicy.limits.snapshot)
      .map(synthesisFact);
    return {
      projectId,
      projectIds: view.projectIds,
      memoryResources: resources.filter((r) =>
        r.id.startsWith("memory.project/"),
      ),
      agentId: this.agentId,
      defaultScope: this.defaultScope,
      sharedMemories: all
        .filter((m) => !m.deleted && !this.owns(m))
        .slice(0, 100)
        .map((m) => ({
          ...synthesisFact(m),
          agentId: m.agentId,
          agentName: m.agentName,
          writable: false,
        })),
      epoch: this.epoch(),
      guardEpoch: this.guardEpoch(),
      fingerprint: synthesisFingerprint(memories),
      // The compatibility view is bounded too; never silently reinterpret old persisted proposals.
      memories: memories.slice(0, 512).map((m) => ({
        ...m,
        value: m.deleted ? null : normalizeMemory(m.value),
      })),
      facts,
    };
  }
  snapshotCurrent(snapshot) {
    const current = this.rebaseSnapshot(snapshot);
    return (
      (snapshot.guardEpoch === undefined
        ? current.epoch === snapshot.epoch
        : current.guardEpoch === snapshot.guardEpoch) &&
      (!snapshot.fingerprint || current.fingerprint === snapshot.fingerprint)
    );
  }
  reviewDue(projectId) {
    const next = this.r.memories.nextReview(
      projectId ? `@project/${projectId}` : this.defaultScope,
    );
    return next <= this.now();
  }
  reviewed(projectId, refreshMs) {
    this.r.memories.reviewed(
      projectId ? `@project/${projectId}` : this.defaultScope,
      this.now() + refreshMs,
    );
  }
  applySynthesis(jobId, snapshot, changes) {
    return this.uow.transaction(() => {
      if (!this.snapshotCurrent(snapshot))
        throw new Error("Memory synthesis snapshot is stale");
      let written = 0;
      const keys = [];
      const rows = this.r.memories
        .catalog({
          projectId: snapshot.projectId,
          projectIds: snapshot.projectIds,
        })
        .filter((m) => this.owns(m));
      for (const c of changes) {
        const target =
          c.action === "create"
            ? null
            : rows.find((m) => !m.deleted && memoryFactId(m) === c.id);
        if (
          c.action !== "create" &&
          (!target || !snapshot.facts?.some((f) => f.id === c.id))
        )
          throw new Error("Unknown memory fact");
        if (
          target &&
          this.r.memories.provenance(target.key)?.origin === "explicit"
        )
          throw new Error("Explicit memory is protected");
        const scope =
            target?.scope ?? c.scope ?? snapshot.defaultScope ?? "user",
          projectId =
            scope === "project"
              ? (target?.projectId ?? c.projectId ?? snapshot.projectId)
              : null;
        if (
          scope === "project" &&
          (!projectId ||
            !this.view().projectIds.includes(projectId) ||
            !(snapshot.projectIds ?? [snapshot.projectId]).includes(projectId))
        )
          throw new Error("Learning project binding changed");
        const content =
          c.action === "remove" ? null : normalizeMemory(c.content);
        const blocked =
          !!content &&
          this.r.memories.tombstoned(
            memoryTombstoneId(scope, projectId, content),
          );
        if (blocked && !target) continue;
        const duplicate =
          content &&
          this.r.memories
            .list(projectId)
            .find(
              (m) =>
                this.owns(m) &&
                m.key !== target?.key &&
                m.scope === scope &&
                m.projectId === projectId &&
                memoryDedupe(m.value) === memoryDedupe(content),
            );
        if (c.action === "create" && duplicate) continue;
        // A merge may remove the superseded automatic/legacy fact; explicit duplicates stay intact.
        const removing = c.action === "remove" || blocked || !!duplicate;
        const key =
          target?.key ??
          memoryKey(
            `fact_${memoryFactId({ scope, projectId, content })}`,
            scope,
            projectId,
          );
        const previous = this.r.memories.get(key);
        if (
          !target &&
          previous?.deleted &&
          this.r.memories.provenance(key)?.origin === "explicit"
        )
          continue; // old explicit key tombstones remain protected
        const m = MemoryEntry.change(
          previous,
          { key, value: content, expectedRevision: previous?.revision ?? 0 },
          jobId,
          removing,
        );
        this.r.memories.save(m);
        this.r.memories.detail(key, {
          scope,
          projectId,
          kind: removing ? target.kind : c.kind,
          updatedAt: this.now(),
        });
        this.r.memories.recordProvenance(
          key,
          m.revision,
          "automatic",
          c.sourceEvidenceIds,
        );
        written++;
        keys.push(key);
      }
      if (written) this.r.meta.advanceMemoryEpoch();
      this.r.events.append(
        "memory.synthesized",
        null,
        { jobId, written, keys },
        this.now(),
      );
      return written;
    });
  }

  applyLearned(jobId, snapshot, changes) {
    return this.uow.transaction(() => {
      if (this.epoch() !== snapshot.epoch)
        throw new Error("Memory synthesis snapshot is stale");
      for (const change of changes) {
        const projectId = change.projectId ?? snapshot.projectId ?? null;
        if (
          change.scope === "project" &&
          (!this.view().projectIds.includes(projectId) ||
            !(snapshot.projectIds ?? [snapshot.projectId]).includes(projectId))
        )
          throw new Error("Learning project binding changed");
        const key = memoryKey(change.key, change.scope ?? "user", projectId);
        if (key !== change.key)
          throw new Error("Learning key was not normalized");
        const previous = this.r.memories.get(change.key);
        if (
          previous &&
          (previous.deleted ||
            this.r.memories.provenance(change.key)?.origin !== "automatic")
        )
          throw new Error("Explicit or forgotten memory is protected");
        if (
          this.r.memories.tombstoned(
            memoryTombstoneId(
              change.scope ?? "user",
              change.scope === "project" ? projectId : null,
              change.value,
            ),
          )
        )
          continue;
        const duplicate = this.r.memories
          .list(projectId)
          .find(
            (m) =>
              this.owns(m) &&
              m.key !== change.key &&
              m.scope === (change.scope ?? "user") &&
              memoryDedupe(m.value) === memoryDedupe(change.value),
          );
        if (duplicate) continue;
        const m = MemoryEntry.change(
          previous,
          { ...change, value: normalizeMemory(change.value) },
          jobId,
          false,
        );
        this.r.memories.save(m);
        this.r.memories.detail(m.key, {
          scope: change.scope ?? previous?.scope ?? "user",
          projectId: change.scope === "project" ? projectId : null,
          kind: memoryKind(change.kind ?? previous?.kind),
          updatedAt: this.now(),
        });
        this.r.memories.recordProvenance(
          m.key,
          m.revision,
          "automatic",
          change.evidenceIds,
        );
      }
      if (changes.length) this.r.meta.advanceMemoryEpoch();
      this.r.events.append(
        "memory.learned",
        null,
        { jobId, keys: changes.map((c) => c.key) },
        this.now(),
      );
    });
  }
  prompt(resources) {
    this.synchronize();
    return {
      ...this.r.memories.prompt(this.view(resources)),
      locations: this.files?.locations(),
    };
  }
  browserSnapshot() {
    this.synchronize();
    return createMemoryBrowserView({rows:this.r.memories.browse(this.view(),{limit:10001}).filter(r=>this.owns(r)),...this.files.browserFiles(),writable:true});
  }
  browse(options={}) {
    this.synchronize();const p=recallOptions(options);
    if(options.kind!==undefined&&!['profile','log'].includes(options.kind))throw Error('Invalid memory kind');
    const rows=this.r.memories.browse(this.view(),{...p,kind:options.kind??null,limit:p.limit+1});
    return {items:rows.slice(0,p.limit).map(m=>this.browserItem(m)),next:rows.length>p.limit?rows[p.limit-1].key:null};
  }
  inspectPrivate(key,includeDeleted=false) {
    requireText(key,'memory key',160);this.synchronize();const m=this.r.memories.get(key);
    if(!m||(!includeDeleted&&m.deleted)||m.scope!=='agent'||!this.owns(m))throw Error('Private memory unavailable');
    const provenance=this.r.memories.provenance(key);return this.browserItem({...m,origin:provenance?.origin,evidenceIds:provenance?.evidence_json?JSON.parse(provenance.evidence_json):[]});
  }
  browserItem(m) {
    return {key:m.key,value:m.value,revision:m.revision,kind:m.kind,updatedAt:m.updatedAt??0,origin:m.origin??'legacy',document:memoryDocument(m),evidenceIds:(m.evidenceIds??[]).slice(0,8)};
  }
  listFiles(options = {}, resources) {
    this.synchronize();
    const { limit } = recallOptions({ limit: options.limit ?? 12 });
    const after = options.after;
    if (after !== undefined) requireText(after, "memory file cursor", 1000);
    const rows = this.r.memories.memoryFiles(this.view(resources), {
      limit: limit + 1,
      after,
    });
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1].documentId : null,
      catalogue: "indexed-memory-files",
    };
  }
  readFile(params = {}, resources) {
    this.synchronize();
    const scope = params.scope ?? this.defaultScope,
      view = this.view(resources),
      projectId =
        scope === "project" ? (params.project ?? view.projectId) : null;
    if (scope === "project" && !view.projectIds.includes(projectId))
      throw new Error("Memory project is outside the original grant");
    if (scope === "agent" && params.agentId && params.agentId !== this.agentId)
      throw new Error("Private agent memory is not shared");
    return this.files.read({ ...params, scope, projectId });
  }
  list(resources) {
    this.synchronize();
    return this.r.memories.list(this.view(resources));
  }
  catalog() {
    this.synchronize();
    return this.r.memories.catalog(this.view());
  }
  recall(options = {}, resources) {
    this.synchronize();
    const p = recallOptions(options),
      projectId = this.projectFor(resources);
    const rows = this.r.memories.recall(this.view(resources), {
      ...p,
      limit: p.limit + 1,
    });
    return {
      items: rows.slice(0, p.limit).map((m) => ({
        ...m,
        document: memoryDocument(m),
        value: typeof m.value === "string" ? m.value.slice(0, 1000) : m.value,
        valueTruncated: (m.value?.length ?? 0) > 1000,
      })),
      next:
        (p.query || p.after) && rows.length > p.limit
          ? rows[p.limit - 1].key
          : null,
      truncated: rows.length > p.limit,
      projectId,
      mode: p.query ? `${p.match}-search` : "profile-and-recent",
      semanticSearch: false,
      match: p.match,
    };
  }
  guardEpoch() {
    this.synchronize();
    return this.r.meta.explicitMemoryEpoch();
  }
  epoch() {
    this.synchronize();
    return this.r.meta.memoryEpoch();
  }
}
