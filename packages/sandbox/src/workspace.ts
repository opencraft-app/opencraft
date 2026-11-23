import { SandboxFault, type Sandbox, type SandboxReceipt } from "./contract.js";
import {
  isSandboxEndpointName,
  openSandboxEndpoint,
  type SandboxEndpointConnection,
  type SandboxEndpointName,
} from "./endpoint.js";
import { formatSandboxEnvironmentUri, type SandboxEnvironmentAddress, type WorkspaceEndpointAddress } from "./uri.js";
import type { SandboxPool } from "./index.js";

/** Provider-neutral workspace placement: a WorkspaceHost holds only typed workspace
 * endpoint addresses; this runtime resolves them to the environment whose
 * `workspace-agent` publishes the name, over whichever provider the composition
 * selected. Every provider supplies the same three things: `create`, optional
 * `attach(receipt)`, and `spawn` (the endpoint relay). Incarnations are observed
 * through the agent's `control` endpoint, never through provider internals. */

export const WORKSPACE_AGENT_CONTROL_PROTOCOL = 1;
export interface WorkspaceAgentIncarnation {
  /** Random per agent start; changes whenever the environment's agent restarts. */
  readonly id: string;
  /** Digest of in-environment birth evidence (boot id, pid, start time). */
  readonly evidence: string;
  readonly startedAt: string;
}
export interface WorkspaceAgentDescription {
  readonly state: string;
  readonly roles: readonly string[];
  readonly incarnation: WorkspaceAgentIncarnation;
  readonly endpoints: readonly SandboxEndpointName[];
  /** Bumped by the agent when an owner behind a described endpoint was replaced in
   * place (same incarnation, new credentials or descriptor). 0 for agents that never do. */
  readonly endpointGeneration: number;
}
/** What an endpoint's client needs besides bytes (bearer credentials, engine
 * descriptor fields). Secrets come only through this authenticated control channel. */
export type WorkspaceEndpointDescriptor = Readonly<Record<string, unknown>>;
export interface WorkspaceAgentLocation {
  /** Interpreter in the environment for the fixed relay. */
  readonly python?: string;
  /** Where the agent publishes named endpoints (an image/template property). */
  readonly endpointDirectory?: string;
}

const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const encoder = new TextEncoder();

/** One request/answer exchange with the environment's agent `control` endpoint. */
export async function requestWorkspaceAgent(
  environment: Pick<Sandbox, "spawn">,
  request: Readonly<Record<string, unknown>>,
  location: WorkspaceAgentLocation = {},
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let text = "",
    answer: ((value: Record<string, unknown>) => void) | undefined,
    failure: ((error: Error) => void) | undefined;
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    answer = resolve;
    failure = reject;
  });
  const connection = await openSandboxEndpoint(environment, {
    target: { name: "control" },
    ...location,
    onData(data) {
      text += decoder.decode(data, { stream: true });
      if (text.length > 256 * 1024) {
        failure?.(fault("SANDBOX_UNAVAILABLE", "Workspace agent answer exceeds its budget"));
        return;
      }
      const end = text.indexOf("\n");
      if (end < 0) return;
      try {
        const value = JSON.parse(text.slice(0, end));
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.protocol !== WORKSPACE_AGENT_CONTROL_PROTOCOL
        )
          throw Error();
        answer?.(value);
      } catch {
        failure?.(fault("SANDBOX_UNAVAILABLE", "Workspace agent answered with an invalid frame"));
      }
    },
  });
  const timer = setTimeout(() => failure?.(fault("SANDBOX_UNAVAILABLE", "Workspace agent did not answer")), timeoutMs);
  void connection.closed.then(() =>
    failure?.(fault("SANDBOX_UNAVAILABLE", "Workspace agent closed without an answer")),
  );
  try {
    await connection.write(
      encoder.encode(JSON.stringify({ ...request, protocol: WORKSPACE_AGENT_CONTROL_PROTOCOL }) + "\n"),
    );
    return await result;
  } finally {
    clearTimeout(timer);
    await connection.close().catch(() => {});
  }
}

export function parseWorkspaceAgentDescription(value: Record<string, unknown>): WorkspaceAgentDescription {
  const incarnation = value.incarnation as Partial<WorkspaceAgentIncarnation> | undefined;
  if (
    (typeof value.state !== "string" && typeof value.type !== "string") ||
    !incarnation ||
    typeof incarnation.id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(incarnation.id) ||
    typeof incarnation.evidence !== "string" ||
    typeof incarnation.startedAt !== "string" ||
    !Array.isArray(value.roles) ||
    !value.roles.every((role) => typeof role === "string") ||
    !Array.isArray(value.endpoints) ||
    !value.endpoints.every(isSandboxEndpointName) ||
    (value.endpointGeneration !== undefined &&
      (!Number.isSafeInteger(value.endpointGeneration) || (value.endpointGeneration as number) < 0))
  )
    throw fault("SANDBOX_UNAVAILABLE", "Workspace agent identity is unavailable");
  return Object.freeze({
    state: typeof value.state === "string" ? value.state : String(value.type),
    roles: Object.freeze([...(value.roles as string[])]),
    incarnation: Object.freeze({
      id: incarnation.id,
      evidence: incarnation.evidence,
      startedAt: incarnation.startedAt,
    }),
    endpoints: Object.freeze([...(value.endpoints as SandboxEndpointName[])]),
    endpointGeneration: (value.endpointGeneration as number | undefined) ?? 0,
  });
}

/** Reads the agent's identity: state, roles, incarnation and published endpoint names. */
export async function probeWorkspaceAgent(
  environment: Pick<Sandbox, "spawn">,
  location?: WorkspaceAgentLocation,
): Promise<WorkspaceAgentDescription> {
  return parseWorkspaceAgentDescription(await requestWorkspaceAgent(environment, { type: "probe" }, location));
}

/** Reads what a named endpoint's client needs (credentials, engine descriptor). */
export async function describeWorkspaceEndpoint(
  environment: Pick<Sandbox, "spawn">,
  name: SandboxEndpointName,
  location?: WorkspaceAgentLocation,
): Promise<WorkspaceEndpointDescriptor> {
  const value = await requestWorkspaceAgent(environment, { type: "describe", name }, location);
  if (
    value.type !== "endpoint" ||
    value.name !== name ||
    !value.descriptor ||
    typeof value.descriptor !== "object" ||
    Array.isArray(value.descriptor)
  )
    throw fault("SANDBOX_UNAVAILABLE", `Workspace endpoint ${name} is not described`);
  return Object.freeze({ ...(value.descriptor as Record<string, unknown>) });
}

/** WorkspaceHost persistence for placement: the last receipt and agent incarnation
 * per environment. Backed by the WorkspaceHost's StateDocumentStore (any deployment). */
export interface WorkspacePlacementRecord {
  readonly receipt?: SandboxReceipt;
  readonly agentIncarnation?: string;
}
export interface WorkspacePlacementStore {
  read(environment: SandboxEnvironmentAddress): Promise<WorkspacePlacementRecord | undefined>;
  write(environment: SandboxEnvironmentAddress, record: WorkspacePlacementRecord): Promise<void>;
}
export interface WorkspaceEnvironmentBinding extends WorkspaceAgentLocation {
  readonly address: SandboxEnvironmentAddress;
  /** Admission for this environment's provider (createSandboxPool over the registered backend). */
  readonly pool: SandboxPool;
}
export type WorkspacePlacementEvent =
  | { readonly type: "attached"; readonly environment: string; readonly incarnation: string }
  | { readonly type: "created"; readonly environment: string; readonly incarnation: string; readonly previous?: string }
  | { readonly type: "attach-failed"; readonly environment: string; readonly code: string }
  | {
      readonly type: "incarnation-changed";
      readonly environment: string;
      readonly incarnation: string;
      readonly previous: string;
    }
  | { readonly type: "released"; readonly environment: string; readonly reason: string };

export interface WorkspaceRuntime {
  readonly workspaceId: string;
  /** One endpoint connection (one attached relay process). No replay: a lost
   * connection is reported once; the caller reconnects and reconciles. */
  connect(endpoint: WorkspaceEndpointAddress, onData: (data: Uint8Array) => void): Promise<SandboxEndpointConnection>;
  /** Cached per bound agent incarnation and endpoint generation; a rebind (restart,
   * re-attach) or an observed in-place owner replacement reads it again. */
  describe(endpoint: WorkspaceEndpointAddress): Promise<WorkspaceEndpointDescriptor>;
  /** Probes every environment's agent now; a changed incarnation is re-bound, a changed
   * endpoint generation drops the cached descriptors. */
  observe(): Promise<
    readonly {
      readonly environment: string;
      readonly incarnation: string;
      readonly endpoints: readonly SandboxEndpointName[];
    }[]
  >;
  /** Idle sleep (§3.7.2): every bound environment whose provider can sleep is stopped and
   * unbound (its receipt stays recorded); the others stay resident. The next `connect`,
   * `describe` or `observe` wakes it through `attach` or `create`. */
  sleep(): Promise<readonly { readonly environment: string; readonly slept: boolean }[]>;
  /** Removes the workspace's provider instances and their retained caches (§3.7.1: content
   * truth is Git) and forgets their receipts. Rejects SANDBOX_UNAVAILABLE, keeping the
   * receipts, when a provider cannot discard (a Compose-declared environment). */
  discard(): Promise<void>;
  close(): Promise<void>;
}

/** One bound environment; descriptors are cached for this binding (one agent incarnation,
 * one endpoint generation). */
interface Bound {
  readonly sandbox: Sandbox;
  readonly agent: WorkspaceAgentDescription;
  readonly descriptors: Map<SandboxEndpointName, Promise<WorkspaceEndpointDescriptor>>;
}

/** Owner of one workspace's environment bindings. Opening an environment: re-attach
 * the persisted receipt; when the provider cannot prove the same instance, create a
 * new one (recovery belongs to the engines' interrupted-turn rules, never replay).
 * The receipt and agent incarnation are persisted before the binding is used. */
export function createWorkspaceRuntime(options: {
  workspaceId: string;
  owner: string;
  environments: readonly WorkspaceEnvironmentBinding[];
  store: WorkspacePlacementStore;
  onEvent?(event: WorkspacePlacementEvent): void;
}): WorkspaceRuntime {
  if (!options.environments.length) throw fault("SANDBOX_POLICY", "A workspace needs at least one environment");
  const slots = options.environments.map((binding) => ({
    binding,
    name: formatSandboxEnvironmentUri(binding.address),
    current: undefined as Bound | undefined,
    opening: undefined as Promise<Bound> | undefined,
  }));
  let closed = false;
  const emit = (event: WorkspacePlacementEvent) => {
    try {
      options.onEvent?.(event);
    } catch {}
  };
  const location = (slot: (typeof slots)[number]): WorkspaceAgentLocation => ({
    ...(slot.binding.python ? { python: slot.binding.python } : {}),
    ...(slot.binding.endpointDirectory ? { endpointDirectory: slot.binding.endpointDirectory } : {}),
  });
  const release = async (slot: (typeof slots)[number], bound: Bound, reason: string) => {
    if (slot.current !== bound) return;
    slot.current = undefined;
    emit({ type: "released", environment: slot.name, reason });
    await bound.sandbox.close().catch(() => {});
  };
  const open = (slot: (typeof slots)[number]) =>
    (slot.opening ??= (async () => {
      if (closed) throw fault("SANDBOX_CLOSED", "Workspace runtime is closed");
      const record = await options.store.read(slot.binding.address);
      let sandbox: Sandbox | undefined,
        attached = false;
      if (record?.receipt) {
        try {
          sandbox = await slot.binding.pool.attachSandbox({ owner: options.owner, receipt: record.receipt });
          attached = true;
        } catch (error) {
          emit({
            type: "attach-failed",
            environment: slot.name,
            code: error instanceof SandboxFault ? error.code : "SANDBOX_UNAVAILABLE",
          });
        }
      }
      sandbox ??= await slot.binding.pool.createSandbox({ owner: options.owner });
      let agent: WorkspaceAgentDescription;
      try {
        agent = await probeWorkspaceAgent(sandbox, location(slot));
        await options.store.write(slot.binding.address, {
          ...(sandbox.receipt ? { receipt: sandbox.receipt } : {}),
          agentIncarnation: agent.incarnation.id,
        });
      } catch (error) {
        await sandbox.close().catch(() => {});
        throw error;
      }
      if (closed) {
        await sandbox.close().catch(() => {});
        throw fault("SANDBOX_CLOSED", "Workspace runtime is closed");
      }
      const previous = record?.agentIncarnation;
      if (attached && previous === agent.incarnation.id)
        emit({ type: "attached", environment: slot.name, incarnation: agent.incarnation.id });
      else if (previous && previous !== agent.incarnation.id)
        emit({
          type: attached ? "incarnation-changed" : "created",
          environment: slot.name,
          incarnation: agent.incarnation.id,
          previous,
        });
      else emit({ type: "created", environment: slot.name, incarnation: agent.incarnation.id });
      const bound: Bound = { sandbox, agent, descriptors: new Map() };
      slot.current = bound;
      return bound;
    })().finally(() => {
      slot.opening = undefined;
    }));
  const bound = async (slot: (typeof slots)[number]) => slot.current ?? open(slot);
  /** The first environment (in configuration order) whose agent publishes the name. */
  const resolve = async (name: SandboxEndpointName) => {
    let lastError: unknown;
    for (const slot of slots) {
      try {
        const value = await bound(slot);
        if (value.agent.endpoints.includes(name)) return { slot, value };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof SandboxFault && lastError.code !== "SANDBOX_POLICY") throw lastError;
    throw fault("SANDBOX_UNAVAILABLE", `No workspace environment publishes ${name}`);
  };
  const check = (endpoint: WorkspaceEndpointAddress) => {
    if (closed) throw fault("SANDBOX_CLOSED", "Workspace runtime is closed");
    if (endpoint?.workspaceId !== options.workspaceId || !isSandboxEndpointName(endpoint.name))
      throw fault("SANDBOX_POLICY", "Endpoint belongs to another workspace");
  };
  /** A relay that cannot even start means the binding is stale (instance gone or
   * restarted): drop it and resolve once more. Nothing was written to the target yet,
   * so this is a fresh connection, not a replay. */
  const withBinding = async <T>(
    name: SandboxEndpointName,
    use: (value: Bound, slot: (typeof slots)[number]) => Promise<T>,
  ) => {
    for (let attempt = 0; ; attempt++) {
      const { slot, value } = await resolve(name);
      try {
        return await use(value, slot);
      } catch (error) {
        const stale =
          error instanceof SandboxFault &&
          ["SANDBOX_START", "SANDBOX_CLOSED", "SANDBOX_UNAVAILABLE"].includes(error.code);
        if (!stale || attempt > 0 || closed) throw error;
        await release(slot, value, error.code);
      }
    }
  };
  return {
    workspaceId: options.workspaceId,
    async connect(endpoint, onData) {
      check(endpoint);
      return withBinding(endpoint.name, (value, slot) =>
        openSandboxEndpoint(value.sandbox, { target: { name: endpoint.name }, ...location(slot), onData }),
      );
    },
    async describe(endpoint) {
      check(endpoint);
      return withBinding(endpoint.name, (value, slot) => {
        let cached = value.descriptors.get(endpoint.name);
        if (!cached) {
          cached = describeWorkspaceEndpoint(value.sandbox, endpoint.name, location(slot));
          value.descriptors.set(endpoint.name, cached);
          void cached.catch(() => {
            if (value.descriptors.get(endpoint.name) === cached) value.descriptors.delete(endpoint.name);
          });
        }
        return cached;
      });
    },
    async observe() {
      if (closed) throw fault("SANDBOX_CLOSED", "Workspace runtime is closed");
      const results = [];
      for (const slot of slots) {
        let value = await bound(slot),
          agent: WorkspaceAgentDescription;
        try {
          agent = await probeWorkspaceAgent(value.sandbox, location(slot));
        } catch (error) {
          await release(slot, value, error instanceof SandboxFault ? error.code : "SANDBOX_UNAVAILABLE");
          value = await bound(slot);
          agent = value.agent;
        }
        if (agent.incarnation.id !== value.agent.incarnation.id) {
          // Same provider instance, restarted agent: rebind so the change is persisted and reported.
          await release(slot, value, "incarnation-changed");
          value = await bound(slot);
          agent = value.agent;
        } else if (agent.endpointGeneration !== value.agent.endpointGeneration && slot.current === value) {
          // Same agent, an owner replaced in place: keep the binding, read descriptors again.
          value = { sandbox: value.sandbox, agent, descriptors: new Map() };
          slot.current = value;
        }
        results.push({ environment: slot.name, incarnation: agent.incarnation.id, endpoints: agent.endpoints });
      }
      return results;
    },
    async sleep() {
      if (closed) throw fault("SANDBOX_CLOSED", "Workspace runtime is closed");
      const results = [];
      for (const slot of slots) {
        await slot.opening?.catch(() => {});
        const value = slot.current;
        if (!value?.sandbox.sleep) {
          results.push({ environment: slot.name, slept: false });
          continue;
        }
        slot.current = undefined;
        await value.sandbox.sleep();
        emit({ type: "released", environment: slot.name, reason: "sleep" });
        results.push({ environment: slot.name, slept: true });
      }
      return results;
    },
    async discard() {
      if (closed) throw fault("SANDBOX_CLOSED", "Workspace runtime is closed");
      const records = [];
      for (const slot of slots) {
        await slot.opening?.catch(() => {});
        const record = await options.store.read(slot.binding.address);
        if (record?.receipt && !slot.binding.pool.discardSandbox)
          throw fault("SANDBOX_UNAVAILABLE", `${slot.name} cannot discard its instance`);
        records.push({ slot, receipt: record?.receipt });
      }
      for (const { slot, receipt } of records) {
        if (slot.current) await release(slot, slot.current, "discard");
        if (receipt) await slot.binding.pool.discardSandbox!({ owner: options.owner, receipt });
        await options.store.write(slot.binding.address, {});
        emit({ type: "released", environment: slot.name, reason: "discarded" });
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled(slots.map((slot) => slot.opening));
      const results = await Promise.allSettled(
        slots.map((slot) => (slot.current ? release(slot, slot.current, "close") : undefined)),
      );
      if (results.some((result) => result.status === "rejected"))
        throw fault("SANDBOX_CLEANUP", "Workspace runtime cleanup is unconfirmed");
    },
  };
}
