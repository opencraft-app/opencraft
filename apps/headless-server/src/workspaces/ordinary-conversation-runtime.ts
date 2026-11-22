import { withRemoteTerminalAdmission, type TerminalAdmissionPort } from "./terminal-admission.js";
import { workspaceArtifactReader } from "./workspace-artifact-reader";
import type { GeneratedFileReader } from "@opencraft/local-agent-host/artifacts/generated-output";
import { transferWorkspaceArtifact } from "./workspace-artifact-transfer";
import type { Artifact } from "@opencraft/local-agent-host/artifacts";
import { verifyOrdinaryWorkspaceMounts } from "./ordinary-workspace-mounts";
import { createSandboxBrowserRuntime } from "./sandbox-browser-runtime";
import { terminalResourceOwnerId } from "../host-resource-identity.js";
import {
  OrdinaryConversationOwner,
  type OrdinaryCreationOptions,
  type OrdinaryExecutionBinding,
} from "@opencraft/local-agent-host/ordinary-conversation-owner";
import { OrdinaryWorkspaceStore, type WorkspaceAuthority } from "@opencraft/local-agent-host/ordinary-workspace-store";
import {
  ordinaryWorkspaceCwd,
  encodeWorkspaceSelection,
  type ResolvedWorkspaceSelection,
} from "@opencraft/execution-environment/workspace-selection";
import { createSandboxConversationBinding } from "@opencraft/local-agent-host/sandbox-conversation-binding";
import { InstalledOrdinaryEnvironmentCatalog, type OrdinaryCatalogContext } from "./ordinary-environment-catalog";
import { InstalledOrdinarySandboxAllocator } from "./ordinary-sandbox-allocator";

type Selection = ResolvedWorkspaceSelection;
/** Constructed only after business admission; never a renderer request schema. */
export interface OrdinaryRuntimeAdmission {
  authority: WorkspaceAuthority;
  catalog: OrdinaryCatalogContext;
  authorize(): Promise<void>;
}
export interface OrdinaryWorkspaceSources {
  resolve(
    admission: OrdinaryRuntimeAdmission,
    environment: Selection["environment"],
    input: unknown,
  ): Promise<Selection["source"]>;
  authorize(admission: OrdinaryRuntimeAdmission, selection: Selection): Promise<void>;
  /** Must verify actual mounts and prepare/resume the exact private copy. No implicit
   * success for an unsupported source. Runs before exposing any execution bridge. */
  prepare(input: {
    admission: OrdinaryRuntimeAdmission;
    selection: Selection;
    allocation: Parameters<OrdinaryCreationOptions["prepare"]>[0];
    workspace: Parameters<OrdinaryCreationOptions["prepare"]>[2];
    authorize(): Promise<void>;
  }): Promise<void>;
}

/** Deployment-owned composition, shared by ordinary clients (not per Web socket).
 * The existing owner/journal remains the only placement/lifecycle writer. The
 * authenticated adapter must supply its normal private Native route, including
 * model/MCP admission and delayed publication; this class exposes no public RPC.
 * Source ownership and Bot+ordinary aggregate budget still belong to composition. */
export class InstalledOrdinaryConversationRuntime {
  private readonly owner: OrdinaryConversationOwner;
  private readonly artifactReaders = new WeakMap<
    OrdinaryExecutionBinding,
    (authorize: () => Promise<void>) => GeneratedFileReader
  >();
  private readonly artifactReadClosers = new Set<() => Promise<void>>();
  private readonly artifactTransfers = new WeakMap<
    OrdinaryExecutionBinding,
    (artifact: Artifact, signal?: AbortSignal, body?: AsyncIterable<Uint8Array>) => Promise<Artifact>
  >();
  private readonly allocator: Pick<InstalledOrdinarySandboxAllocator, "allocate" | "inspect" | "close">;
  private closing?: Promise<void>;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private cleanupUnconfirmed = false;
  constructor(
    private readonly store: OrdinaryWorkspaceStore,
    private readonly catalog: InstalledOrdinaryEnvironmentCatalog,
    private readonly sources: OrdinaryWorkspaceSources,
    private readonly dependencies: {
      allocator?: Pick<InstalledOrdinarySandboxAllocator, "allocate" | "inspect" | "close">;
      terminalAdmission?: TerminalAdmissionPort;
      verifyMounts?: typeof verifyOrdinaryWorkspaceMounts;
      bind?: (options: Parameters<typeof createSandboxConversationBinding>[0]) => Promise<OrdinaryExecutionBinding>;
      /** Trusted deployment policy for the preinstalled Hands browser runtime. */
      browser?: {
        isolation: Parameters<typeof createSandboxBrowserRuntime>[0]["isolation"];
      };
    } = {},
  ) {
    this.owner = new OrdinaryConversationOwner(store);
    this.allocator = dependencies.allocator ?? new InstalledOrdinarySandboxAllocator(catalog);
  }
  private admission(input: OrdinaryRuntimeAdmission): OrdinaryRuntimeAdmission {
    const authority = Object.freeze({ principalId: input.authority.principalId, hostId: input.authority.hostId }),
      scope = input.catalog.scope;
    const current = () =>
      !this.closed &&
      input.authority.principalId === authority.principalId &&
      input.authority.hostId === authority.hostId &&
      input.catalog.scope === scope &&
      input.catalog.current();
    const catalog = Object.freeze({ scope, current });
    return Object.freeze({
      authority,
      catalog,
      authorize: async () => {
        if (!current()) throw Error("Ordinary runtime admission expired");
        await input.authorize();
        if (!current()) throw Error("Ordinary runtime admission expired");
      },
    });
  }
  private lifecycle(admission: OrdinaryRuntimeAdmission, fixed: Selection) {
    const snapshot = encodeWorkspaceSelection(fixed).json;
    const selection = () => JSON.parse(snapshot) as Selection;
    let lost = false,
      notifyLoss: (() => void) | undefined;
    const authorize = async () => {
      await admission.authorize();
      if (lost) throw Error("Ordinary runtime lease lost");
      const selected = selection();
      await this.catalog.runtime(admission.catalog, selected.environment).authorize();
      if (selected.source.kind === "library-reference")
        this.catalog.libraryBinding(admission.catalog, selected.environment, selected.source);
      await this.sources.authorize(admission, selected);
      await admission.authorize();
      if (lost) throw Error("Ordinary runtime lease lost");
    };
    const onLost = () => {
      lost = true;
      notifyLoss?.();
    };
    return {
      authority: admission.authority,
      authorize,
      allocate: async (lease: Parameters<OrdinaryCreationOptions["allocate"]>[0]) => {
        const allocation = await this.allocator.allocate({
          context: admission.catalog,
          environment: selection().environment,
          lease,
          authorize,
          onLost,
        });
        const terminals = withRemoteTerminalAdmission(allocation.environment, {
          port: this.dependencies.terminalAdmission,
          authorize,
          quotaOwner: terminalResourceOwnerId(admission.authority.principalId, admission.authority.hostId),
          resource: JSON.stringify([lease.workspaceId, lease.generation, allocation.instanceId]),
          onCleanupUnconfirmed: () => {
            this.cleanupUnconfirmed = true;
          },
        });
        let closing: Promise<void> | undefined;
        return {
          ...allocation,
          environment: terminals.environment,
          close: () =>
            (closing ??= (async () => {
              terminals.retire();
              await allocation.close();
              await terminals.confirmDestroyed();
            })()),
        };
      },
      prepare: async (
        allocation: Parameters<OrdinaryCreationOptions["prepare"]>[0],
        ownerAuthorize: () => Promise<void>,
        workspace: Parameters<OrdinaryCreationOptions["prepare"]>[2],
      ) => {
        notifyLoss = workspace.onLost;
        await ownerAuthorize();
        const selected = selection(),
          installed = this.catalog.runtime(admission.catalog, selected.environment);
        let library: { volumeId: string; relativePath: string } | undefined;
        if (selected.source.kind !== "empty") {
          const reference =
            selected.source.kind === "library-reference"
              ? selected.source
              : this.catalog.resolveLibrary(admission.catalog, selected.environment, {
                  version: 1,
                  kind: "library-reference",
                  libraryId: selected.source.libraryId,
                  relativePath: "",
                });
          const declared = this.catalog.libraryBinding(admission.catalog, selected.environment, reference);
          library = { volumeId: declared.volumeId, relativePath: declared.relativePath };
        }
        if (!allocation.privateVolumeId) throw Error("Ordinary private volume receipt unavailable");
        await (this.dependencies.verifyMounts ?? verifyOrdinaryWorkspaceMounts)({
          sandbox: allocation.environment,
          workspaceId: workspace.workspaceId,
          instanceId: allocation.instanceId,
          privateVolumeId: allocation.privateVolumeId,
          library,
          apiUrl: installed.apiUrl,
          readApiKey: installed.readApiKey,
          authorize: ownerAuthorize,
          onCleanupUnconfirmed: () => {
            this.cleanupUnconfirmed = true;
          },
        });
        await this.sources.prepare({
          admission,
          selection: selection(),
          allocation,
          workspace,
          authorize: ownerAuthorize,
        });
        const cwd = ordinaryWorkspaceCwd(selection());
        await ownerAuthorize();
        const installedBrowser = this.catalog.runtime(admission.catalog, selection().environment).template.browser;
        const browserConfiguration = this.dependencies.browser ?? installedBrowser;
        const binding = await (this.dependencies.bind ?? createSandboxConversationBinding)({
          sandbox: allocation.environment,
          terminalSupported: allocation.environment.capabilities.terminal,
          probeTerminalAdmission: async () => {
            if (!this.dependencies.terminalAdmission) throw Error("Shared Hands terminal admission unavailable");
            await this.dependencies.terminalAdmission.probeTerminalAdmission();
          },
          cwd,
          environmentId: workspace.environmentId,
          workspaceLease: { workspaceId: workspace.workspaceId, generation: workspace.generation },
          processContext: {
            projectId: null,
            resourceOwnerId: terminalResourceOwnerId(admission.authority.principalId, admission.authority.hostId),
            ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          },
          authorize: ownerAuthorize,
          onLost,
          onCleanupUnconfirmed: () => {
            this.cleanupUnconfirmed = true;
          },
        });
        this.artifactReaders.set(binding, (authorize) =>
          workspaceArtifactReader({
            sandbox: allocation.environment,
            authorize: async () => {
              await ownerAuthorize();
              await authorize();
            },
            onCleanupUnconfirmed: () => {
              this.cleanupUnconfirmed = true;
            },
          }),
        );
        this.artifactTransfers.set(binding, (artifact, signal, body) =>
          transferWorkspaceArtifact({
            sandbox: allocation.environment,
            artifact,
            signal,
            body,
            authorize: ownerAuthorize,
            onCleanupUnconfirmed: () => {
              this.cleanupUnconfirmed = true;
            },
          }),
        );
        if (browserConfiguration) {
          try {
            if (!binding.isCurrent) throw Error("Browser requires an incarnation-aware execution binding");
            const browser = createSandboxBrowserRuntime({
              sandbox: allocation.environment,
              isolation: browserConfiguration.isolation,
              authorize: ownerAuthorize,
              assertCurrent: () => {
                if (!admission.catalog.current() || !binding.isCurrent!())
                  throw Error("Browser execution binding retired");
              },
              onLost,
              onCleanupUnconfirmed: () => {
                this.cleanupUnconfirmed = true;
              },
            });
            const closeExecution = binding.close.bind(binding);
            let closing: Promise<void> | undefined;
            // Mutate only this new private binding, preserving processes getter and
            // bindThread's deferred terminal publication. Do not spread/copy it.
            Object.defineProperty(binding, "browser", { value: browser, enumerable: false });
            binding.close = () =>
              (closing ??= (async () => {
                let failed = false;
                try {
                  await browser.close();
                } catch {
                  failed = true;
                }
                try {
                  await closeExecution();
                } catch {
                  failed = true;
                }
                if (failed) {
                  this.cleanupUnconfirmed = true;
                  throw Error("Workspace binding cleanup unconfirmed");
                }
              })());
          } catch (error) {
            try {
              await binding.close();
            } catch {
              this.cleanupUnconfirmed = true;
            }
            throw error;
          }
        }
        // Once returned, the owner owns binding cleanup even if admission expired.
        return binding;
      },
      inspect: (binding: { workspaceId: string; privateVolumeId: string }) =>
        this.allocator.inspect(admission.catalog, selection().environment, binding, authorize),
    };
  }
  start(input: {
    admission: OrdinaryRuntimeAdmission;
    intentId: string;
    environment: unknown;
    source: unknown;
    nativeStart: OrdinaryCreationOptions["nativeStart"];
  }) {
    return this.track(async () => {
      const admission = this.admission(input.admission),
        intentId = input.intentId;
      const target = structuredClone(input.environment),
        source = structuredClone(input.source);
      await admission.authorize();
      const environment = this.catalog.resolveEnvironment(admission.catalog, target);
      const selection = encodeWorkspaceSelection({
        version: 1,
        environment,
        source: await this.sources.resolve(admission, structuredClone(environment), source),
      }).value;
      await admission.authorize();
      return this.owner.start({
        ...this.lifecycle(admission, selection),
        intentId,
        selection,
        nativeStart: input.nativeStart,
      });
    });
  }
  restore(input: {
    admission: OrdinaryRuntimeAdmission;
    threadId: string;
    nativeResume(
      threadId: string,
      fields: Awaited<ReturnType<OrdinaryExecutionBinding["executionFields"]>>,
      binding: OrdinaryExecutionBinding,
    ): Promise<unknown>;
  }) {
    return this.track(async () => {
      const admission = this.admission(input.admission),
        threadId = input.threadId;
      await admission.authorize();
      const row = this.store.forThread(admission.authority, threadId);
      if (!row) throw Error("Ordinary workspace binding not found");
      const selection = this.store.resolvedSelection(admission.authority, row.workspaceId);
      return this.owner.restore({
        ...this.lifecycle(admission, selection),
        threadId,
        nativeResume: input.nativeResume,
      });
    });
  }
  /** Routing only; callers still need bindingFor with fresh admission. */
  hasPlacement(hostId: string, threadId: string): boolean {
    if (this.closed) throw Error("Ordinary runtime closed");
    return this.store.hasThread(hostId, threadId);
  }
  /** Read-only file placement projection. It never allocates/resumes compute,
   * and host-wide classification prevents a foreign workspace becoming local. */
  fileScopeFor(input: OrdinaryRuntimeAdmission, threadId: string) {
    return this.track(async () => {
      const admission = this.admission(input);
      await admission.authorize();
      if (!this.store.hasThread(admission.authority.hostId, threadId)) {
        await admission.authorize();
        return { kind: "host" as const };
      }
      const row = this.store.forThread(admission.authority, threadId);
      if (!row) throw Error("Workspace file scope unavailable");
      const selection = this.store.resolvedSelection(admission.authority, row.workspaceId);
      await this.catalog.runtime(admission.catalog, selection.environment).authorize();
      await this.sources.authorize(admission, selection);
      await admission.authorize();
      return { kind: "workspace" as const, threadId, root: ordinaryWorkspaceCwd(selection) };
    });
  }
  async bindingFor(input: OrdinaryRuntimeAdmission, threadId: string) {
    const admission = this.admission(input);
    await admission.authorize();
    const binding = await this.owner.bindingFor(admission.authority, threadId);
    await admission.authorize();
    return binding;
  }
  prepareArtifactFor(
    input: OrdinaryRuntimeAdmission,
    threadId: string,
    artifact: Artifact,
    signal?: AbortSignal,
    body?: AsyncIterable<Uint8Array>,
  ) {
    return this.track(async () => {
      const admission = this.admission(input);
      const binding = await this.bindingFor(admission, threadId);
      const transfer = this.artifactTransfers.get(binding);
      if (!transfer) throw Error("Workspace attachment transfer unavailable");
      const delivered = await transfer(artifact, signal, body);
      if ((await this.bindingFor(admission, threadId)) !== binding) throw Error("Workspace attachment binding retired");
      return delivered;
    });
  }
  readArtifactFor(input: OrdinaryRuntimeAdmission, threadId: string, path: string, signal?: AbortSignal) {
    return this.track(async () => {
      const admission = this.admission(input);
      const binding = await this.bindingFor(admission, threadId);
      const createReader = this.artifactReaders.get(binding);
      if (!createReader) throw Error("Workspace artifact reader unavailable");
      const authorize = async () => {
        if ((await this.bindingFor(admission, threadId)) !== binding) throw Error("Workspace output binding retired");
      };
      const stream = await createReader(authorize)(path, signal);
      let closing: Promise<void> | undefined;
      const dispose = () => (closing ??= stream.dispose().finally(() => this.artifactReadClosers.delete(dispose)));
      this.artifactReadClosers.add(dispose);
      stream.body.once("close", () => {
        void dispose().catch(() => {
          this.cleanupUnconfirmed = true;
        });
      });
      try {
        await authorize();
        return { body: stream.body, dispose };
      } catch (error) {
        await dispose();
        throw error;
      }
    });
  }
  /** Committed system lifecycle, never an end-user resource selector. */
  applyThreadLifecycle(row: Parameters<OrdinaryConversationOwner["applyThreadLifecycle"]>[0]) {
    return this.owner.applyThreadLifecycle(row);
  }
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error("Ordinary runtime closed"));
    const operation = run();
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  /** Owns owner/pool shutdown, NOT the injected journal. The deployment closes the
   * journal only after this settles, including failures. Never drops cleanup error. */
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      const failures: unknown[] = [];
      const readers = await Promise.allSettled([...this.artifactReadClosers].map((close) => close()));
      for (const result of readers) if (result.status === "rejected") failures.push(result.reason);
      try {
        await this.owner.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.allocator.close();
      } catch (error) {
        failures.push(error);
      }
      if (this.cleanupUnconfirmed || failures.length)
        throw new AggregateError(failures, "Ordinary runtime cleanup unconfirmed");
    })());
  }
}
