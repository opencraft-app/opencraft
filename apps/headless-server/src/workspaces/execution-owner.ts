import { WorkspaceBrowserTransfers, type WorkspaceBrowserPort } from "./browser-transports.js";
import { WorkspaceTerminalTransfers, type WorkspaceTerminalPort } from "./terminal-transports.js";
import { WorkspaceArtifactTransfers, type WorkspaceArtifactPort } from "./artifact-transports.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { acquireProcessWriter } from "@opencraft/sqlite-node";
import type { WorkspaceExecutionSelection } from "@opencraft/sandbox-node/workspace-execution-channel";
import type {
  AssetWorkspaceOwnerContext,
  AssetWorkspaceExecutionOwner,
} from "@opencraft/plugin-assets/server/workspace-owner";
import { withWorkspaceBudget } from "@opencraft/plugin-assets/server/workspace-budget";
import { e2bSandboxBackend } from "@opencraft/sandbox-e2b";
import { OrdinaryWorkspaceStore, type WorkspaceLease } from "@opencraft/local-agent-host/ordinary-workspace-store";
import {
  InstalledOrdinaryConversationRuntime,
  type OrdinaryRuntimeAdmission,
} from "./ordinary-conversation-runtime.js";
import { InstalledOrdinarySandboxAllocator } from "./ordinary-sandbox-allocator.js";
import { InstalledOrdinaryWorkspaceSources, PublishedOrdinaryGitSources } from "./ordinary-git-sources.js";
import { WorkspaceActorAuthority, workspaceAdmission, type WorkspaceActorAdmission } from "./actor-authority.js";

type Fields = { cwd: string; runtimeWorkspaceRoots: string[]; environments: { environmentId: string; cwd: string }[] };
export type WorkspacePreparation =
  { kind: "start"; intentId: string; environment: unknown; source?: unknown } | { kind: "restore"; threadId: string };
export type WorkspacePreparationStatus =
  | { state: "preparing" }
  | { state: "native-ready"; fields: Fields; selection: WorkspaceExecutionSelection }
  | { state: "complete"; receipt: { workspaceId: string; threadId: string } }
  | { state: "failed" };
export interface WorkspaceExecutionPort extends WorkspaceArtifactPort, WorkspaceTerminalPort, WorkspaceBrowserPort {
  workspaceBegin(access: WorkspaceActorAdmission, request: WorkspacePreparation): Promise<string>;
  workspaceStatus(token: string): Promise<WorkspacePreparationStatus>;
  workspaceNativeReceipt(
    token: string,
    reply: { result: unknown } | { error: true },
  ): Promise<{ workspaceId: string; threadId: string }>;
  workspaceCancel(token: string): Promise<void>;
  workspaceForget(token: string): Promise<void>;
  workspaceSelection(access: WorkspaceActorAdmission, threadId: string): Promise<WorkspaceExecutionSelection>;
  workspaceFileScope(
    access: WorkspaceActorAdmission,
    threadId: string,
  ): Promise<{ kind: "host" } | { kind: "workspace"; threadId: string; root: string }>;
  workspaceFileRequest(
    access: WorkspaceActorAdmission,
    threadId: string,
    method: string,
    params: unknown,
  ): Promise<unknown>;
  workspacePlacementPage(
    after?: string,
  ): Promise<{ items: { workspaceId: string; hostId: string; threadId: string }[]; next: string | null }>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
interface Attempt {
  kind: "start" | "restore";
  expectedThreadId?: string;
  lease?: WorkspaceLease;
  active: boolean;
  published: boolean;
  receipted: boolean;
  access: WorkspaceActorAdmission;
  status: WorkspacePreparationStatus;
  native: ReturnType<typeof deferred<unknown>>;
  completion: Promise<{ workspaceId: string; threadId: string }>;
}
/** Resident in the sole Assets Worker, not Main or an engine socket. Native
 * preparation and positive receipt are separate private operations; neither
 * retries physical delivery nor exposes provider secrets or callbacks to Main. */
export async function createWorkspaceExecutionOwner(
  context: AssetWorkspaceOwnerContext,
  options: {
    machineId: string;
    runtime?: (
      store: OrdinaryWorkspaceStore,
      context: AssetWorkspaceOwnerContext,
    ) => InstalledOrdinaryConversationRuntime;
  },
): Promise<AssetWorkspaceExecutionOwner> {
  if (!validId(options.machineId)) throw Error("Workspace owner requires machine identity");
  const directory = join(context.directory, "ordinary-workspaces");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = acquireProcessWriter(join(directory, "writer.lock"));
  let store: OrdinaryWorkspaceStore | undefined, runtime: InstalledOrdinaryConversationRuntime | undefined;
  const actors = new WorkspaceActorAuthority(context.directory),
    attempts = new Map<string, Attempt>();
  let closed = false,
    closing: Promise<void> | undefined;
  try {
    store = new OrdinaryWorkspaceStore(directory, options.machineId);
    runtime =
      options.runtime?.(store, context) ??
      new InstalledOrdinaryConversationRuntime(
        store,
        context.catalog,
        new InstalledOrdinaryWorkspaceSources(context.catalog, new PublishedOrdinaryGitSources(context.vault)),
        {
          allocator: new InstalledOrdinarySandboxAllocator(context.catalog, {
            backend: (input) =>
              withWorkspaceBudget(
                {
                  workspaceBudgetReserve: async (...args) => context.budget.reserve(...args),
                  workspaceBudgetSettle: async (...args) => context.budget.settle(...args),
                },
                "ordinary",
                e2bSandboxBackend(input),
              ),
          }),
        },
      );
  } catch (cause) {
    store?.close();
    actors.close();
    release();
    throw cause;
  }
  const owned = runtime,
    journal = store;
  const current = (access: WorkspaceActorAdmission, pending: boolean) => !closed && actors.current(access, pending);
  const admission = (access: WorkspaceActorAdmission, state?: Attempt, resource = false): OrdinaryRuntimeAdmission => {
    const alive = () =>
      current(access, state ? !state.published : !resource) && (!state || state.published || state.active);
    return {
      authority: { principalId: access.actorId, hostId: "local-codex" },
      catalog: { scope: "actor:" + access.actorId, current: alive },
      authorize: async () => {
        if (!alive()) throw Error("Workspace authority unavailable");
      },
    };
  };
  const lookup = (token: string) => {
    if (closed || typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token))
      throw Error("Workspace preparation unavailable");
    const value = attempts.get(token);
    if (!value) throw Error("Workspace preparation unavailable");
    return value;
  };
  const artifacts = new WorkspaceArtifactTransfers({
    current: (access) => current(access, true),
    download: (access, threadId, path, signal) => owned.readArtifactFor(admission(access), threadId, path, signal),
    upload: (access, threadId, artifact, body, signal) =>
      owned.prepareArtifactFor(admission(access), threadId, artifact, signal, body),
  });
  const terminals = new WorkspaceTerminalTransfers({
    current: (access, pending) => current(access, pending),
    binding: (access, threadId, resource) => owned.bindingFor(admission(access, undefined, resource), threadId),
  });
  const browsers = new WorkspaceBrowserTransfers({
    current: (access, pending) => current(access, pending),
    binding: (access, threadId) => owned.bindingFor(admission(access, undefined, true), threadId),
  });
  const methods: WorkspaceExecutionPort = {
    async workspaceBrowserOpen(raw, threadId, lease) {
      return browsers.open(workspaceAdmission(raw), threadId, lease);
    },
    async workspaceBrowserStatus(token) {
      return structuredClone(await browsers.status(token));
    },
    async workspaceBrowserRead(token, after) {
      return structuredClone(await browsers.read(token, after));
    },
    async workspaceBrowserSend(token, sequence, message) {
      browsers.send(token, sequence, message);
    },
    async workspaceBrowserSent(token, sequence) {
      return browsers.sent(token, sequence);
    },
    async workspaceBrowserForget(token, sequence) {
      browsers.forget(token, sequence);
    },
    async workspaceBrowserClose(token) {
      return browsers.requestClose(token);
    },
    async workspaceTerminalOpen(raw, threadId, lease) {
      return terminals.open(workspaceAdmission(raw), threadId, lease);
    },
    async workspaceTerminalProbe(token) {
      await terminals.probe(token);
    },
    async workspaceTerminalRequest(token, raw, method, params) {
      return terminals.begin(token, workspaceAdmission(raw), method, params);
    },
    async workspaceTerminalStatus(token) {
      return structuredClone(terminals.status(token));
    },
    async workspaceTerminalForget(token) {
      terminals.forget(token);
    },
    async workspaceTerminalSnapshot(token, handle, afterSequence) {
      return terminals.snapshot(token, handle, afterSequence);
    },
    async workspaceTerminalUnwatch(token) {
      terminals.unwatch(token);
    },
    async workspaceArtifactDownload(raw, threadId, path) {
      if (!validId(threadId) || typeof path !== "string" || path.length > 8192)
        throw Error("Workspace output unavailable");
      return artifacts.download(workspaceAdmission(raw), threadId, path);
    },
    async workspaceArtifactRead(token, sequence) {
      return artifacts.read(token, sequence);
    },
    async workspaceArtifactUpload(raw, threadId, artifact) {
      if (!validId(threadId)) throw Error("Workspace attachment unavailable");
      return artifacts.upload(workspaceAdmission(raw), threadId, artifact);
    },
    async workspaceArtifactWrite(token, sequence, data) {
      return artifacts.write(token, sequence, data);
    },
    async workspaceArtifactFinish(token) {
      return artifacts.finish(token);
    },
    async workspaceArtifactClose(token) {
      return artifacts.requestClose(token);
    },
    async workspaceBegin(raw, request) {
      const access = workspaceAdmission(raw);
      if (
        closed ||
        attempts.size >= 64 ||
        !current(access, true) ||
        !request ||
        typeof request !== "object" ||
        (request.kind === "start"
          ? !validId(request.intentId) ||
            Object.keys(request).some((k) => !["kind", "intentId", "environment", "source"].includes(k))
          : request.kind !== "restore" ||
            !validId(request.threadId) ||
            Object.keys(request).some((k) => !["kind", "threadId"].includes(k)))
      )
        throw Error("Workspace preparation unavailable");
      const token = randomBytes(32).toString("hex"),
        native = deferred<unknown>();
      // No unhandled rejection when cancellation precedes the callback phase.
      void native.promise.catch(() => {});
      const state: Attempt = {
        kind: request.kind,
        ...(request.kind === "restore" ? { expectedThreadId: request.threadId } : {}),
        active: true,
        published: false,
        receipted: false,
        access,
        status: { state: "preparing" },
        native,
        completion: undefined!,
      };
      attempts.set(token, state);
      const admitted = admission(access, state);
      const nativeReady = async (
        fields: Fields,
        binding: { executionSelection?(): Promise<WorkspaceExecutionSelection> },
      ) => {
        await admitted.authorize();
        if (!binding.executionSelection) throw Error("Workspace execution selection unavailable");
        const selection = await binding.executionSelection();
        await admitted.authorize();
        if (selection.kind !== "bound") throw Error("Workspace binding cannot become local");
        const row = journal.read(admitted.authority, selection.workspaceId);
        if (row.generation !== selection.generation || !row.leaseOwner) throw Error("Workspace generation changed");
        state.lease = { workspaceId: row.workspaceId, generation: row.generation, owner: row.leaseOwner };
        state.status = { state: "native-ready", fields: structuredClone(fields), selection };
        return native.promise;
      };
      let resumed = false;
      state.completion =
        request.kind === "start"
          ? owned.start({
              admission: admitted,
              intentId: request.intentId,
              environment: structuredClone(request.environment),
              source: structuredClone(request.source ?? { kind: "empty" }),
              nativeStart: nativeReady,
            })
          : (async () => {
              const receipt = await owned.restore({
                admission: admitted,
                threadId: request.threadId,
                nativeResume: (_thread, fields, binding) => {
                  resumed = true;
                  return nativeReady(fields, binding);
                },
              });
              if (!resumed) {
                // A live resource can skip allocation, never the client's actual
                // Native resume. Reusing compute is not a Native success receipt.
                const binding = await owned.bindingFor(admitted, request.threadId);
                const reply = await nativeReady(await binding.executionFields(), binding);
                if ((reply as { thread?: { id?: unknown } } | null)?.thread?.id !== request.threadId)
                  throw Error("Native workspace identity mismatch");
                await admitted.authorize();
              }
              return receipt;
            })();
      void state.completion.then(
        (receipt) => {
          state.published = true;
          state.status = { state: "complete", receipt };
        },
        () => {
          state.status = { state: "failed" };
        },
      );
      return token;
    },
    async workspaceStatus(token) {
      return structuredClone(lookup(token).status);
    },
    async workspaceNativeReceipt(token, reply) {
      const state = lookup(token);
      if (
        state.receipted ||
        !state.lease ||
        !reply ||
        typeof reply !== "object" ||
        Object.keys(reply).length !== 1 ||
        (!Object.hasOwn(reply, "result") && (!("error" in reply) || reply.error !== true))
      )
        throw Error("Workspace receipt unavailable");
      // The private token correlates the actual Native response. Record positive
      // identity evidence even after request/Actor revocation; the runtime then
      // reauthorizes before publication and retires compute on denial.
      if ("result" in reply) {
        const threadId = (reply.result as { thread?: { id?: unknown } } | null)?.thread?.id;
        if (!validId(threadId) || (state.kind === "restore" && threadId !== state.expectedThreadId))
          throw Error("Native workspace identity mismatch");
        state.receipted = true;
        if (state.kind === "start" && !state.active)
          journal.confirmThreadStarted(
            { principalId: state.access.actorId, hostId: "local-codex" },
            state.lease,
            threadId,
          );
        state.native.resolve(reply.result);
      } else {
        state.receipted = true;
        state.native.reject(Error("Native workspace request rejected"));
      }
      try {
        return await state.completion;
      } catch {
        throw Error("Workspace completion unavailable");
      }
    },
    async workspaceCancel(token) {
      const state = lookup(token);
      if (state.published) return;
      state.active = false;
      state.native.reject(Error("Workspace request cancelled"));
    },
    async workspaceForget(token) {
      const state = lookup(token);
      if (state.kind === "start" && state.lease && !state.receipted)
        throw Error("Native workspace receipt remains unresolved");
      if (!["complete", "failed"].includes(state.status.state)) throw Error("Workspace preparation is unsettled");
      attempts.delete(token);
    },
    async workspaceSelection(raw, threadId) {
      const access = workspaceAdmission(raw),
        admitted = admission(access);
      if (!validId(threadId)) throw Error("Workspace thread unavailable");
      const binding = await owned.bindingFor(admitted, threadId);
      if (!binding.executionSelection) throw Error("Workspace execution selection unavailable");
      const selection = await binding.executionSelection();
      await admitted.authorize();
      return selection;
    },
    async workspaceFileScope(raw, threadId) {
      const access = workspaceAdmission(raw);
      if (!validId(threadId)) throw Error("Workspace thread unavailable");
      return owned.fileScopeFor(admission(access), threadId);
    },
    async workspaceFileRequest(raw, threadId, method, params) {
      const access = workspaceAdmission(raw),
        admitted = admission(access);
      if (!validId(threadId)) throw Error("Workspace thread unavailable");
      const binding = await owned.bindingFor(admitted, threadId);
      if (!binding.files) throw Error("Workspace files unavailable");
      const controller = new AbortController();
      const timer = setInterval(() => {
        if (!current(access, true)) controller.abort();
      }, 50);
      timer.unref();
      try {
        await admitted.authorize();
        const result = await binding.files.request(method, params, controller.signal);
        await admitted.authorize();
        return result;
      } finally {
        clearInterval(timer);
      }
    },
    async workspacePlacementPage(after = "") {
      if (closed) throw Error("Workspace owner closed");
      const items = journal.placementPage("local-codex", after, 256);
      return { items, next: items.length === 256 ? items[items.length - 1]!.workspaceId : null };
    },
  };
  return {
    methods: methods as unknown as AssetWorkspaceExecutionOwner["methods"],
    close: () =>
      (closing ??= (async () => {
        closed = true;
        for (const state of attempts.values())
          if (!state.published) {
            state.active = false;
            state.native.reject(Error("Workspace owner closed"));
          }
        const errors: unknown[] = [];
        try {
          await browsers.closeAll();
        } catch (error) {
          errors.push(error);
        }
        try {
          await terminals.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await artifacts.closeAll();
        } catch (error) {
          errors.push(error);
        }
        try {
          await owned.close();
        } catch (error) {
          errors.push(error);
        }
        actors.close();
        try {
          journal.close();
          release();
        } catch (error) {
          errors.push(error);
        }
        attempts.clear();
        if (errors.length) throw new AggregateError(errors, "Workspace cleanup unconfirmed");
      })()),
  };
}
