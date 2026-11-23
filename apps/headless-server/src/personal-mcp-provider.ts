import type {
  CapabilityResult,
  CapabilitySession,
  CapabilityTool,
  SessionCapabilityProvider,
} from "@opencraft/session-capabilities";
import type {
  ExecutionSessionLocator,
  PersonalMcpActor,
  PersonalMcpOperation,
  PersonalMcpPort,
  PersonalMcpService,
} from "@opencraft/plugin-assets/server/personal-mcp";
import type { WorkspaceActorAdmission } from "./workspaces/actor-authority.js";

export type { PersonalMcpPort, PersonalMcpService } from "@opencraft/plugin-assets/server/personal-mcp";

type Cached = { actor: PersonalMcpActor; access: WorkspaceActorAdmission; tools: readonly CapabilityTool[] };
const unavailable = () =>
  Error("MCP authorization expired or service unavailable; uncertain effects must not be replayed");
const live = (access: WorkspaceActorAdmission) =>
  access.expiresAt > Date.now() &&
  Atomics.load(access.requestPermit, 0) === 1 &&
  Atomics.load(access.resourcePermit, 0) === 1;
const hosts = new Set(["local-codex", "opencraft-server"]);
// A tool's callId is not the catalog identity.
const key = (s: CapabilitySession) =>
  JSON.stringify([
    s.serverId,
    s.threadId,
    s.execution?.inputId,
    s.execution?.executionId,
    s.execution?.turnId,
    s.execution?.incarnation,
  ]);
/** Only a run whose Host and Human Actor core resolved can be located; model
 * arguments never select the Thread, input or account. */
function locate(session: CapabilitySession): ExecutionSessionLocator | null {
  const context = session.context,
    execution = session.execution;
  if (!context?.actor || !hosts.has(context.host.id) || !execution || (!execution.inputId && !execution.turnId))
    return null;
  return Object.freeze({
    hostId: context.host.id as ExecutionSessionLocator["hostId"],
    threadId: session.threadId,
    ...(execution.inputId ? { inputId: execution.inputId } : {}),
    ...(execution.turnId ? { turnId: execution.turnId } : {}),
    ...(execution.executionId ? { executionId: execution.executionId } : {}),
    ...(execution.incarnation ? { incarnation: execution.incarnation } : {}),
  });
}
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(unavailable());
  }
  return new Promise((resolve, reject) => {
    const stop = () => reject(unavailable());
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** Gateway session capability for one personal MCP service whose token and
 * MCP client live in the vault Worker (`createPersonalMcpOwner`). Main holds
 * only the catalog, the Worker handle and the session policy: the Worker's
 * core session reader names the Actor that owns the run, which must be the
 * Actor core resolved into `session.context`, and `authorize` issues that
 * Actor's Human proof (for example the workspace execution service's
 * `admitResource`). No SDK, token, vault access, network fallback or retry of
 * an uncertain call. */
export function createPersonalMcpProvider(options: {
  service: Pick<PersonalMcpService, "id" | "prefix">;
  port: Pick<
    PersonalMcpPort,
    "personalMcpOwner" | "personalMcpBegin" | "personalMcpStatus" | "personalMcpCancel" | "personalMcpForget"
  >;
  authorize(actor: PersonalMcpActor, session: CapabilitySession): WorkspaceActorAdmission;
}): SessionCapabilityProvider & { close(): void } {
  const { id, prefix } = options.service,
    port = options.port;
  const cache = new Map<string, Cached>(),
    refreshing = new Map<string, object>(),
    active = new Map<Int32Array, AbortController>();
  let closed = false;
  const check = (actor: PersonalMcpActor, session: CapabilitySession, original?: WorkspaceActorAdmission) => {
    if (closed || (original && !live(original))) throw unavailable();
    const resolved = session.context?.actor;
    if (!resolved || resolved.id !== actor.actorId || resolved.generation !== actor.generation) throw unavailable();
    const access = options.authorize(actor, session);
    if (
      !live(access) ||
      access.actorId !== actor.actorId ||
      access.generation !== actor.generation ||
      (original &&
        (access.actorId !== original.actorId ||
          access.generation !== original.generation ||
          access.membershipRevision !== original.membershipRevision))
    )
      throw unavailable();
    return access;
  };
  const cleanup = (handle: string) => {
    void Promise.allSettled([port.personalMcpCancel(handle), port.personalMcpForget(handle)]);
  };
  async function operation(session: CapabilitySession, request: PersonalMcpOperation, external?: AbortSignal) {
    if (closed || active.size >= 16 || external?.aborted) throw unavailable();
    const locator = locate(session);
    if (!locator) return null;
    const controller = new AbortController(),
      permit = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(permit, 0, 1);
    const cancel = () => {
      Atomics.store(permit, 0, 0);
      controller.abort();
    };
    active.set(permit, controller);
    external?.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(cancel, 60_000);
    deadline.unref();
    let handle: string | undefined;
    try {
      const actor = await until(port.personalMcpOwner(id, locator, request.kind === "call"), controller.signal);
      if (!actor) return null;
      const access = check(actor, session);
      const begin = port.personalMcpBegin(access, id, locator, request, permit);
      // A late begin acknowledgement cannot keep an abandoned operation
      // authorized: the shared permit is retired before the handle is known.
      void begin.then(
        (value) => {
          if (closed || !Atomics.load(permit, 0)) cleanup(value);
        },
        () => {},
      );
      handle = await until(begin, controller.signal);
      for (;;) {
        check(actor, session, access);
        const status = await until(port.personalMcpStatus(access, id, locator, handle), controller.signal);
        check(actor, session, access);
        if (status.state === "failed") throw unavailable();
        if (status.state === "complete") return { actor, access, value: status.value };
        await until(new Promise<void>((resolve) => setTimeout(resolve, 10)), controller.signal);
      }
    } finally {
      cancel();
      clearTimeout(deadline);
      external?.removeEventListener("abort", cancel);
      active.delete(permit);
      if (handle) cleanup(handle); // Never block cancellation on a paused Worker.
    }
  }
  const provider: SessionCapabilityProvider & { close(): void } = {
    id,
    async refresh(session) {
      const sessionKey = key(session),
        revision = {};
      cache.delete(sessionKey);
      refreshing.set(sessionKey, revision);
      try {
        const result = await operation(session, { kind: "catalog" });
        if (!result || refreshing.get(sessionKey) !== revision) return;
        const tools = result.value;
        if (
          !Array.isArray(tools) ||
          tools.length > 256 ||
          tools.some((tool) => typeof tool?.name !== "string" || !tool.name.startsWith(prefix))
        )
          throw unavailable();
        check(result.actor, session, result.access);
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(sessionKey, { actor: result.actor, access: result.access, tools: structuredClone(tools) });
      } catch (error) {
        // No token stored is an empty catalog, not a failed run.
        if (error && typeof error === "object" && "code" in error && error.code === "unconfigured") return;
        throw unavailable();
      } finally {
        if (refreshing.get(sessionKey) === revision) refreshing.delete(sessionKey);
      }
    },
    tools(session) {
      const entry = cache.get(key(session));
      if (!entry) return [];
      try {
        check(entry.actor, session, entry.access);
        return structuredClone(entry.tools);
      } catch {
        cache.delete(key(session));
        return [];
      }
    },
    async call(session, name, args, signal) {
      const entry = cache.get(key(session));
      if (
        !entry ||
        !provider.tools(session).some((tool) => tool.name === name) ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      )
        throw unavailable();
      try {
        const result = await operation(session, { kind: "call", name, args: args as Record<string, unknown> }, signal);
        if (!result) throw unavailable();
        return result.value;
      } catch {
        if (cache.get(key(session)) === entry) cache.delete(key(session));
        throw unavailable();
      }
    },
    formatResult(value): CapabilityResult {
      const result = value as { isError?: boolean; content?: unknown } | null;
      return {
        success: result?.isError !== true,
        contentItems: [{ type: "inputText", text: JSON.stringify(result?.content ?? []) }],
      };
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      refreshing.clear();
      for (const [permit, controller] of active) {
        Atomics.store(permit, 0, 0);
        controller.abort();
      }
      active.clear();
    },
  };
  return provider;
}
