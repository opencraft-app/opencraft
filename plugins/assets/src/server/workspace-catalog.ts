import { createHash } from "node:crypto";
import {
  isSandboxExecutionTarget as isComposerSandboxTarget,
  isWorkspaceSource as isComposerWorkspaceSource,
} from "@opencraft/chat-core";
import {
  encodeWorkspaceSelection,
  type ResolvedWorkspaceSelection,
} from "@opencraft/execution-environment/workspace-selection";
import { ManagedNfsLibraries, type ManagedNfsLibrary } from "./libraries.js";
import type { SandboxConfigurations } from "./configurations.js";

/** Supplied by authenticated Human admission, never decoded from a request. */
export interface WorkspaceCatalogContext {
  readonly scope: string;
  current(): boolean;
}
type Environment = ResolvedWorkspaceSelection["environment"];
type LibraryReference = Extract<ResolvedWorkspaceSelection["source"], { kind: "library-reference" }>;
const unavailable = (): never => {
  throw Error("ordinary_workspace_configuration_unavailable");
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Resolve settings-owned installation identities, not arbitrary personal saved
 * configurations. This is an admission catalog, not an allocator or public API.
 * Git refs/base generations remain owned by the authorized Git source resolver. */
export class InstalledWorkspaceCatalog {
  constructor(private readonly configurations: SandboxConfigurations) {}
  private assert(context: WorkspaceCatalogContext) {
    if (
      !context ||
      typeof context.scope !== "string" ||
      !/^actor:human:\/\/[^/]+\/[^/]+$/u.test(context.scope) ||
      context.scope.length > 512 ||
      /[\x00-\x1f\x7f]/u.test(context.scope) ||
      !context.current()
    )
      unavailable();
  }
  private installed(context: WorkspaceCatalogContext) {
    this.assert(context);
    const value = this.configurations.installedRuntime();
    this.assert(context);
    if (!value || !value.policy.persistentWorkspaces) return unavailable();
    return value;
  }
  private environment(context: WorkspaceCatalogContext, target: unknown) {
    if (!isComposerSandboxTarget(target)) return unavailable();
    const installed = this.installed(context);
    const record = installed.records.find(
      (r) => r.environment.id === target.configurationId && r.environment.templateId === target.templateId,
    );
    if (!record || record.policy.workspaceRoot !== "/workspace") return unavailable();
    const { environment, credential, policy } = record;
    const configurationRevision = digest([
      environment.id,
      environment.templateId,
      credential.id,
      credential.generation,
      credential.apiUrl,
      credential.sandboxUrl,
      policy.workspaceRoot,
      policy.resources.cpuMillis,
      policy.resources.memoryBytes,
      policy.python ?? null,
      installed.policy.capacity.cpuMillis,
      installed.policy.capacity.memoryBytes,
      installed.policy.lease.timeoutMs,
      installed.policy.lease.renewEveryMs,
      installed.policy.lease.maxLifetimeMs,
      installed.policy.maxCommandMs,
      installed.policy.persistentWorkspaces,
      ...(policy.browser ? [policy.browser] : []),
    ]);
    const selection: Environment = {
      configurationId: environment.id,
      configurationRevision,
      templateId: environment.templateId,
      cpuMillis: policy.resources.cpuMillis,
      memoryBytes: policy.resources.memoryBytes,
    };
    return { installed, record, selection };
  }
  /** Secret-free configured choices. Configured does not imply a launched lease
   * or that default conversation composition is enabled. */
  snapshot(context: WorkspaceCatalogContext) {
    const installed = this.installed(context);
    const environments = installed.records
      .filter((r) => r.policy.workspaceRoot === "/workspace")
      .map((r) => ({
        target: { version: 1 as const, configurationId: r.environment.id, templateId: r.environment.templateId },
        name: r.environment.name,
        status: "configured" as const,
        resources: { ...r.policy.resources },
      }));
    const libraries = new ManagedNfsLibraries(this.configurations.vault).snapshot(
      installed.records.map((r) => ({
        environmentId: r.environment.id,
        templateId: r.environment.templateId,
        credentialId: r.credential.id,
        credentialGeneration: r.credential.generation,
      })),
    ).libraries;
    this.assert(context);
    return { environments, libraries };
  }
  resolveEnvironment(context: WorkspaceCatalogContext, target: unknown): Environment {
    return this.environment(context, target).selection;
  }
  private currentEnvironment(context: WorkspaceCatalogContext, environment: Environment) {
    const canonical = encodeWorkspaceSelection({ version: 1, environment, source: { kind: "empty" } }).value
      .environment;
    const current = this.environment(context, {
      version: 1,
      configurationId: canonical.configurationId,
      templateId: canonical.templateId,
    });
    if (JSON.stringify(current.selection) !== JSON.stringify(canonical)) return unavailable();
    return current;
  }
  /** Private provider inputs; key bytes are fetched only at use and after checking
   * the exact admitted revision. No silently selecting the latest replacement. */
  runtime(context: WorkspaceCatalogContext, environment: Environment) {
    const scope = context.scope;
    const admission = { scope, current: () => context.scope === scope && context.current() };
    const fixed = structuredClone(environment),
      current = this.currentEnvironment(admission, fixed);
    return {
      policy: structuredClone(current.installed.policy),
      template: structuredClone(current.record.policy),
      apiUrl: current.record.credential.apiUrl,
      sandboxUrl: current.record.credential.sandboxUrl,
      templateId: fixed.templateId,
      authorize: async () => {
        this.currentEnvironment(admission, fixed);
      },
      readApiKey: async () => this.currentEnvironment(admission, fixed).record.credential.apiKey,
    };
  }
  private library(context: WorkspaceCatalogContext, environment: Environment, libraryId: string) {
    const { record } = this.currentEnvironment(context, environment);
    const library = new ManagedNfsLibraries(this.configurations.vault).read().libraries.find((l) => l.id === libraryId);
    const index = library?.environmentIds.indexOf(record.environment.id) ?? -1;
    if (
      !library ||
      index < 0 ||
      library.templateIds[index] !== record.environment.templateId ||
      library.credentialId !== record.credential.id ||
      library.credentialGeneration !== record.credential.generation
    )
      return unavailable();
    this.assert(context);
    return library;
  }
  private reference(
    context: WorkspaceCatalogContext,
    library: ManagedNfsLibrary,
    relativePath: string,
  ): LibraryReference {
    return {
      kind: "library-reference",
      libraryId: library.id,
      relativePath,
      authorizationDomain:
        "scope-" + digest([context.scope, library.id, library.credentialId, library.credentialGeneration]),
      // Identity of the declared live mount, NOT a snapshot of mutable NFS files.
      generation: digest([
        library.id,
        library.volumeId,
        library.mountPath,
        library.credentialId,
        library.credentialGeneration,
      ]),
    };
  }
  resolveLibrary(context: WorkspaceCatalogContext, environment: Environment, source: unknown): LibraryReference {
    if (!isComposerWorkspaceSource(source) || source.kind !== "library-reference") return unavailable();
    return this.reference(context, this.library(context, environment, source.libraryId), source.relativePath);
  }
  /** The preparation layer must still verify the provider's actual shared volume
   * and safely resolve the relative path. This declaration never mounts anything. */
  libraryBinding(context: WorkspaceCatalogContext, environment: Environment, source: LibraryReference) {
    const canonical = encodeWorkspaceSelection({ version: 1, environment, source }).value.source;
    if (canonical.kind !== "library-reference") return unavailable();
    const library = this.library(context, environment, canonical.libraryId);
    const current = this.reference(context, library, canonical.relativePath);
    if (
      JSON.stringify(current) !==
      JSON.stringify({
        kind: canonical.kind,
        libraryId: canonical.libraryId,
        relativePath: canonical.relativePath,
        authorizationDomain: canonical.authorizationDomain,
        generation: canonical.generation,
      })
    )
      return unavailable();
    return { mountPath: library.mountPath, volumeId: library.volumeId, relativePath: canonical.relativePath };
  }
}
