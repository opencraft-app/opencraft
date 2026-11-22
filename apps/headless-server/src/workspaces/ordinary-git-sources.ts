import { createHash } from "node:crypto";
import type { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { isWorkspaceSource as isComposerWorkspaceSource } from "@opencraft/chat-core";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import type { OrdinaryRuntimeAdmission, OrdinaryWorkspaceSources } from "./ordinary-conversation-runtime";
import { InstalledOrdinaryEnvironmentCatalog } from "./ordinary-environment-catalog";
import { prepareOrdinaryGitCopy } from "./ordinary-git-copy";

type Source = Extract<ResolvedWorkspaceSelection["source"], { kind: "git" }>;
export type OrdinaryGitPublication = {
  repositoryId: string;
  remote: string;
  libraryId: string;
  generation: string;
  commit: string;
  ref: string;
};
type Repository = {
  id: string;
  remote: string;
  libraryId: string;
  enabled: boolean;
  generations: { id: string; commit: string }[];
  refs: { name: string; generation: string }[];
};
type Document = { version: 1; repositories: Repository[] };
const namespace = "document-ordinary-git-bases";
const fail = (): never => {
  throw Error("ordinary_git_source_unavailable");
};
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(v);
const commit = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
function remote(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== value)
    return fail();
  return value;
}
const ref = (value: unknown) =>
  isComposerWorkspaceSource({ version: 1, kind: "git", repositoryId: "r", ref: value, relativePath: "" });
const domain = (scope: string, repositoryId: string) =>
  "scope-" +
  createHash("sha256")
    .update(JSON.stringify([scope, repositoryId]))
    .digest("hex");

/* Describes the expected immutable manifest before upload; this is not an
 * authorization or publication receipt. The publisher still verifies bytes. */
export function describeOrdinaryGitPublication(scope: string, input: OrdinaryGitPublication) {
  if (
    typeof scope !== "string" ||
    !scope ||
    scope.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(scope) ||
    !id(input.repositoryId) ||
    !id(input.libraryId) ||
    !id(input.generation) ||
    !commit(input.commit) ||
    !ref(input.ref)
  )
    return fail();
  return {
    remote: remote(input.remote),
    source: {
      kind: "git" as const,
      repositoryId: input.repositoryId,
      libraryId: input.libraryId,
      authorizationDomain: domain(scope, input.repositoryId),
      generation: input.generation,
      commit: input.commit,
      relativePath: "",
    },
  };
}

/** Index of already published immutable baselines, NOT permission to clone an
 * arbitrary remote. Only the trusted authenticated publisher calls publish after
 * verifying/uploading the complete generation. No public RPC mutates this index.
 * Old generations remain referenced; moving a ref cannot change a pinned source. */
export class PublishedOrdinaryGitSources {
  constructor(private readonly vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">) {}
  private read(scope: string) {
    if (typeof scope !== "string" || !scope || scope.length > 256 || /[\x00-\x1f\x7f]/u.test(scope)) return fail();
    const saved = this.vault.readDocument(scope, namespace);
    const d = (saved.document ?? { version: 1, repositories: [] }) as Document;
    if (d?.version !== 1 || !Array.isArray(d.repositories) || d.repositories.length > 128) return fail();
    const ids = new Set<string>();
    for (const r of d.repositories) {
      if (
        !r ||
        !id(r.id) ||
        ids.has(r.id) ||
        !id(r.libraryId) ||
        typeof r.enabled !== "boolean" ||
        !Array.isArray(r.generations) ||
        r.generations.length > 2048 ||
        !Array.isArray(r.refs) ||
        r.refs.length > 256
      )
        return fail();
      remote(r.remote);
      ids.add(r.id);
      const generations = new Set<string>(),
        refs = new Set<string>();
      for (const g of r.generations) {
        if (!g || !id(g.id) || generations.has(g.id) || !commit(g.commit)) return fail();
        generations.add(g.id);
      }
      for (const f of r.refs) {
        if (!f || !ref(f.name) || refs.has(f.name) || !generations.has(f.generation)) return fail();
        refs.add(f.name);
      }
    }
    return { revision: saved.revision, document: structuredClone(d) };
  }
  /** Trusted publication receipt; never renderer request data. CAS prevents
   * concurrent publishers from losing refs or rewriting generation identities. */
  publish(scope: string, expectedRevision: number, input: OrdinaryGitPublication) {
    const descriptor = describeOrdinaryGitPublication(scope, input);
    const url = descriptor.remote,
      state = this.read(scope);
    if (state.revision !== expectedRevision) throw Error("ordinary_git_source_conflict");
    let r = state.document.repositories.find((r) => r.id === input.repositoryId);
    if (!r) {
      r = { id: input.repositoryId, remote: url, libraryId: input.libraryId, enabled: true, generations: [], refs: [] };
      state.document.repositories.push(r);
    }
    if (!r.enabled || r.remote !== url || r.libraryId !== input.libraryId) return fail();
    const generation = r.generations.find((g) => g.id === input.generation);
    if (generation && generation.commit !== input.commit) return fail();
    if (!generation) r.generations.push({ id: input.generation, commit: input.commit });
    r.refs = r.refs.filter((f) => f.name !== input.ref).concat({ name: input.ref, generation: input.generation });
    if (state.document.repositories.length > 128 || r.generations.length > 2048 || r.refs.length > 256) return fail();
    this.vault.writeDocument(scope, namespace, state.revision, state.document);
  }
  /** Disabling removes future admission without pruning shared objects or copies. */
  disable(scope: string, expectedRevision: number, repositoryId: string) {
    const state = this.read(scope);
    if (state.revision !== expectedRevision) throw Error("ordinary_git_source_conflict");
    const r = state.document.repositories.find((r) => r.id === repositoryId);
    if (!r) return fail();
    r.enabled = false;
    this.vault.writeDocument(scope, namespace, state.revision, state.document);
  }
  resolve(scope: string, input: unknown): Source {
    if (!isComposerWorkspaceSource(input) || input.kind !== "git") return fail();
    const r = this.read(scope).document.repositories.find((r) => r.id === input.repositoryId && r.enabled);
    if (!r || (input.libraryId !== undefined && input.libraryId !== r.libraryId)) return fail();
    const f = r.refs.find((f) => f.name === input.ref),
      g = r.generations.find((g) => g.id === f?.generation);
    if (!g) return fail();
    return {
      kind: "git",
      repositoryId: r.id,
      libraryId: r.libraryId,
      authorizationDomain: domain(scope, r.id),
      generation: g.id,
      commit: g.commit,
      relativePath: input.relativePath,
    };
  }
  pinned(scope: string, source: Source): { remote: string } {
    if (source.authorizationDomain !== domain(scope, source.repositoryId)) return fail();
    const r = this.read(scope).document.repositories.find((r) => r.id === source.repositoryId && r.enabled);
    if (
      !r ||
      r.libraryId !== source.libraryId ||
      !r.generations.some((g) => g.id === source.generation && g.commit === source.commit)
    )
      return fail();
    return { remote: r.remote };
  }
}

/** Concrete source resolver for the installed runtime. The runtime checks actual
 * mounts before prepare; this owner checks source admission and immutable Git
 * manifests. No network clone/fetch/push or automatic publication occurs here. */
export class InstalledOrdinaryWorkspaceSources implements OrdinaryWorkspaceSources {
  constructor(
    private readonly catalog: InstalledOrdinaryEnvironmentCatalog,
    private readonly git: PublishedOrdinaryGitSources,
  ) {}
  private library(
    admission: OrdinaryRuntimeAdmission,
    environment: ResolvedWorkspaceSelection["environment"],
    libraryId: string,
  ) {
    return this.catalog.resolveLibrary(admission.catalog, environment, {
      version: 1,
      kind: "library-reference",
      libraryId,
      relativePath: "",
    });
  }
  async resolve(
    admission: OrdinaryRuntimeAdmission,
    environment: ResolvedWorkspaceSelection["environment"],
    input: unknown,
  ) {
    await admission.authorize();
    if (
      input === undefined ||
      input === null ||
      (typeof input === "object" &&
        !Array.isArray(input) &&
        Object.keys(input).length === 1 &&
        ("kind" in input && input.kind) === "empty")
    )
      return { kind: "empty" as const };
    if (!isComposerWorkspaceSource(input)) return fail();
    if (input.kind === "library-reference") return this.catalog.resolveLibrary(admission.catalog, environment, input);
    const selected = this.git.resolve(admission.catalog.scope, input);
    this.library(admission, environment, selected.libraryId);
    return selected;
  }
  async authorize(admission: OrdinaryRuntimeAdmission, selection: ResolvedWorkspaceSelection) {
    await admission.authorize();
    await this.catalog.runtime(admission.catalog, selection.environment).authorize();
    if (selection.source.kind === "git") {
      this.git.pinned(admission.catalog.scope, selection.source);
      this.library(admission, selection.environment, selection.source.libraryId);
    } else if (selection.source.kind === "library-reference")
      this.catalog.libraryBinding(admission.catalog, selection.environment, selection.source);
    await admission.authorize();
  }
  async prepare(input: Parameters<OrdinaryWorkspaceSources["prepare"]>[0]) {
    await input.authorize();
    await this.authorize(input.admission, input.selection);
    if (input.selection.source.kind === "git") {
      const { remote } = this.git.pinned(input.admission.catalog.scope, input.selection.source);
      await prepareOrdinaryGitCopy({
        sandbox: input.allocation.environment,
        selection: input.selection,
        remote,
        authorize: async () => {
          await input.authorize();
          await this.authorize(input.admission, input.selection);
        },
      });
    }
    await input.authorize();
  }
}
