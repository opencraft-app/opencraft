import { randomUUID } from "node:crypto";
import { isWorkspacePlacement } from "@opencraft/chat-core";
import type { TransportSubmissionContext, DuplexTransport } from "@opencraft/appserver-client/transport";
import { workspaceExecutionTransport } from "@opencraft/opencraft-daemon/workspace-execution-transport";
import type {
  createWorkspaceExecutionAuthority,
  WorkspaceExecutionSelection,
} from "@opencraft/sandbox-node/workspace-execution-channel";
import type { CodexWorkspaceHooks } from "../codex-workspace-hooks.mjs";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import type { WorkspaceExecutionPort } from "./execution-owner.js";
import { WorkspaceNativeHandoff } from "./native-handoff.js";
import { WorkspacePlacementProjection } from "./placement-projection.js";

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u.test(value);
export function readWorkspacePlacement(params: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(params, "workspacePlacement")) return null;
  const value = params.workspacePlacement;
  if (
    !isWorkspacePlacement(value) ||
    params.ephemeral === true ||
    params.cwd != null ||
    (params.runtimeWorkspaceRoots !== undefined &&
      (!Array.isArray(params.runtimeWorkspaceRoots) || params.runtimeWorkspaceRoots.length !== 0)) ||
    (params.environments !== undefined && (!Array.isArray(params.environments) || params.environments.length !== 0))
  )
    throw Error("Invalid workspace placement");
  return {
    intentId: value.intentId,
    environment: structuredClone(value.environment),
    source: structuredClone(value.source ?? { kind: "empty" as const }),
  };
}

/** Side chats alone may join their parent's durable working copy. */
export function readWorkspaceFork(params: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(params, "workspaceFork")) return null;
  const value = params.workspaceFork;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || (value as {kind?:unknown}).kind !== "side-chat" || !id((value as {intentId?:unknown}).intentId)
    || !id(params.threadId) || params.ephemeral === true) throw Error("Invalid shared workspace fork");
  return {parentThreadId:params.threadId, intentId:(value as {intentId:string}).intentId};
}

/** A new attachment for each physical adapter, with only private Worker RPC and
 * the existing one-shot Core authority. No SDK, credentials or journal in Main. */
export function createWorkspaceNativeRouting(options: {
  port: WorkspaceExecutionPort;
  placement: WorkspacePlacementProjection;
  authority: Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>>;
  admit(context: TransportSubmissionContext): WorkspaceActorAdmission;
  assertThreadActive?(threadId: string): void;
  onCleanupUnconfirmed(): void;
  readWorkspaceArtifact?: CodexWorkspaceHooks["readWorkspaceArtifact"];
  prepareWorkspaceArtifact?: CodexWorkspaceHooks["prepareWorkspaceArtifact"];
}): CodexWorkspaceHooks {
  const handoff = new WorkspaceNativeHandoff({ ...options, placementChanged: () => options.placement.refresh() });
  const owned = new Map<string, () => void>(),
    key = (value: string | number) => JSON.stringify([typeof value, value]);
  const pending = new Set<Promise<void>>();
  let stopped = false,
    attached = false;
  const check = () => {
    if (stopped) throw Error("Workspace attachment unavailable");
  };
  const report = () => {
    try {
      options.onCleanupUnconfirmed();
    } catch {
      /* Observer cannot prevent cleanup. */
    }
  };
  const track = (work: Promise<void>) => {
    const safe = work.catch(report);
    pending.add(safe);
    void safe.finally(() => pending.delete(safe));
  };
  const finalize: NonNullable<CodexWorkspaceHooks["finalizeNativeCreation"]> = async (input) => {
    const entry = owned.get(key(input.requestId));
    if (!entry) return;
    try {
      await handoff.finalize(input);
    } finally {
      entry();
      owned.delete(key(input.requestId));
    }
  };
  return {
    readWorkspaceArtifact: options.readWorkspaceArtifact,
    prepareWorkspaceArtifact: options.prepareWorkspaceArtifact,
    requiresWorkspaceResume: (threadId) => {
      check();
      return options.placement.has(threadId);
    },
    finalizeNativeCreation: finalize,
    finalizeNativeResume: finalize,
    finalizeNativeFork: finalize,
    async restoreProvisionalWorkspace(input) {
      check();
      options.assertThreadActive?.(input.threadId);
      const requestId = "provisional:" + randomUUID();
      const prepared = await handoff.prepare(
        requestId,
        {
          method: "thread/resume",
          context: () => {
            check();
            input.context.resourceOwner?.assertCurrent();
            options.admit(input.context);
            options.assertThreadActive?.(input.threadId);
            return input.context;
          },
        },
        { kind: "restore", threadId: input.threadId },
      );
      try {
        if (prepared.kind !== "dispatch") throw Error("Workspace provisional receipt missing");
        await prepared.resolve();
        // Existing positive, live Native identity is authoritative for an empty
        // Thread. This hook never invents a Native resume or replays creation.
        await handoff.finalize({ requestId, context: input.context, result: await input.confirm() });
      } catch (cause) {
        await handoff.abort(requestId);
        throw cause;
      }
    },
    decorateNativeTransport(native, lookup) {
      check();
      if (attached) throw Error("Workspace attachment already installed");
      attached = true;
      let wasOpen = native.status.state === "open";
      const unsubscribe = native.subscribeStatus((status) => {
        if (status.state === "open") {
          wasOpen = true;
          return;
        }
        if (wasOpen) {
          wasOpen = false;
          options.placement.forgetNativeLocal();
          track(handoff.interrupt());
        }
      });
      const removeObservation = native.subscribeMessage((frame) => {
        const current = native.captureMessageScope?.() ?? (() => native.status.state === "open");
        if (!current()) return;
        try {
          const message = JSON.parse(frame);
          if (message?.result?.thread) options.placement.observeNativeThread(message.result.thread);
          if (message?.method === "thread/started") options.placement.observeNativeThread(message.params?.thread);
        } catch {
          options.placement.invalidate();
          report();
        }
      });
      const prepared = workspaceExecutionTransport(native, options.authority, async (method, params, physical) => {
        check();
        const request = lookup(physical.id);
        if (!request || request.method !== method) throw Error("Workspace Native admission unavailable");
        request.context();
        const placement = method === "thread/start" ? readWorkspacePlacement(params) : null;
        const fork = method === "thread/fork" ? readWorkspaceFork(params) : null;
        const remoteThread = id(params.threadId) && options.placement.has(params.threadId);
        if (placement || (method === "thread/resume" && remoteThread) || (method === "thread/fork" && remoteThread && fork)) {
          const operation = placement
            ? { kind: "start" as const, ...placement }
            : method === "thread/fork" && fork
              ? {kind:"fork" as const,...fork}
              : { kind: "restore" as const, threadId: String(params.threadId) };
          if (operation.kind === "restore") options.assertThreadActive?.(operation.threadId);
          if (operation.kind === "fork") options.assertThreadActive?.(operation.parentThreadId);
          const ready = await handoff.prepare(physical.id, request, operation);
          if (ready.kind === "existing") throw Error("Workspace already created; resume the existing Thread");
          return async () => {
            if (operation.kind === "restore") options.assertThreadActive?.(operation.threadId);
            if (operation.kind === "fork") options.assertThreadActive?.(operation.parentThreadId);
            return ready.resolve();
          };
        }
        if (method === "thread/start")
          return async () => {
            check();
            request.context();
            return { kind: "local" as const };
          };
        if (!id(params.threadId)) throw Error("Workspace routing requires a durable Thread");
        const threadId = params.threadId;
        options.assertThreadActive?.(threadId);
        if (!options.placement.has(threadId))
          return async () => {
            check();
            request.context();
            if (options.placement.has(threadId)) throw Error("Workspace placement changed");
            // A journal absence is not execution proof: Core also checks the real
            // Native environment selection before accepting a local turn or fork.
            return { kind: "local" as const };
          };
        if (method !== "turn/start") throw Error("Workspace restoration not admitted");
        const admission = options.admit(request.context());
        const selected = await options.port.workspaceSelection(admission, threadId);
        return async (): Promise<WorkspaceExecutionSelection> => {
          check();
          request.context();
          options.admit(request.context());
          options.assertThreadActive?.(threadId);
          const current = await options.port.workspaceSelection(admission, threadId);
          check();
          request.context();
          if (JSON.stringify(selected) !== JSON.stringify(current))
            throw Error("Workspace execution generation changed");
          return current;
        };
      });
      let closing: Promise<void> | undefined;
      const transport: DuplexTransport = {
        ...prepared,
        get status() {
          return native.status;
        },
        async send(frame, signal, progress) {
          check();
          signal?.throwIfAborted();
          const message = JSON.parse(frame),
            params = message?.params;
          let requestId: string | number | undefined;
          if (params && typeof params === "object" && !Array.isArray(params)) {
            if (message.method !== "thread/start" && Object.hasOwn(params, "workspacePlacement"))
              throw Error("Placement is creation-only");
            if (message.method !== "thread/fork" && Object.hasOwn(params, "workspaceFork"))
              throw Error("Workspace fork intent is fork-only");
            const fork = message.method === "thread/fork" ? readWorkspaceFork(params) : null;
            if (message.method === "thread/resume" || message.method === "thread/fork") {
              if (
                !id(params.threadId) ||
                params.history != null ||
                (message.method === "thread/fork" && params.path != null && params.path !== "")
              )
                throw Error("Workspace routing requires a durable Thread");
              if (message.method === "thread/resume") {
                delete params.path;
                // Old clients cache a cwd. An unclassified unloaded rollout
                // must reveal its own Native selection, never be redirected.
                if (!options.placement.has(params.threadId)) {
                  delete params.cwd;
                  delete params.runtimeWorkspaceRoots;
                  delete params.environments;
                }
                frame = JSON.stringify(message);
              }
            }
            const remote = id(params.threadId) && options.placement.has(params.threadId);
            if (message.method === "thread/fork" && remote && !fork)
              throw Error("Workspace fork requires a side-chat intent");
            const placement = message.method === "thread/start" && readWorkspacePlacement(params);
            if (
              Array.isArray(params.environments) &&
              params.environments.some(
                (value: unknown) =>
                  value &&
                  typeof value === "object" &&
                  "environmentId" in value &&
                  typeof value.environmentId === "string" &&
                  value.environmentId.startsWith("workspace-"),
              ) &&
              !remote &&
              !placement
            )
              throw Error("Workspace environment has no admitted placement");
            if (placement || (message.method === "thread/resume" && remote) || (message.method === "thread/fork" && remote && fork)) {
              if (
                (typeof message.id !== "string" && typeof message.id !== "number") ||
                owned.size >= 64 ||
                owned.has(key(message.id))
              )
                throw Error("Workspace Native correlation unavailable");
              requestId = message.id;
              const abort = () => track(handoff.abort(message.id));
              signal?.addEventListener("abort", abort, { once: true });
              owned.set(key(message.id), () => signal?.removeEventListener("abort", abort));
            }
          }
          try {
            await prepared.send(frame, signal, progress);
          } catch (cause) {
            if (requestId !== undefined) {
              await handoff.abort(requestId);
              if (!handoff.retainsReceipt(requestId)) {
                owned.get(key(requestId))?.();
                owned.delete(key(requestId));
              }
            }
            throw cause;
          }
        },
        close: () =>
          (closing ??= (async () => {
            stopped = true;
            unsubscribe();
            removeObservation();
            options.placement.forgetNativeLocal();
            for (const remove of owned.values()) remove();
            const results = await Promise.allSettled([handoff.close(), native.close()]);
            while (pending.size) await Promise.all([...pending]);
            const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
            if (failures.length) {
              report();
              throw new AggregateError(failures, "Workspace attachment cleanup unconfirmed");
            }
          })()),
      };
      return transport;
    },
  };
}
