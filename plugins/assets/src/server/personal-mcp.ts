import { randomBytes } from "node:crypto";
import { AuthenticatedMcpProvider, type McpCredential } from "@opencraft/session-capabilities/authenticated-mcp";
import type { CapabilitySession } from "@opencraft/session-capabilities";
import { GitVaultError, type EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { SandboxConfigurationError } from "./errors.js";

/** One third-party MCP service a person reaches with their own token. A
 * composition compiles this into its vault Worker entry and its Gateway; it is
 * never read from Worker data, a request or configuration. */
export interface PersonalMcpService {
  /** Session capability provider id, e.g. `example`. */
  readonly id: string;
  /** Prefix of every tool name the service contributes, e.g. `example_`. */
  readonly prefix: string;
  /** The only URL the token is ever sent to. */
  readonly endpoint: string;
  /** Vault service name the token is stored under in the Actor partition. */
  readonly service: string;
  /** A token must match this pattern as a whole before it is stored or used. */
  readonly tokenPattern: RegExp;
}

/** Locator of a native session: its Host, Thread and original input or
 * native Turn, optionally pinned to one execution and engine incarnation. */
export interface ExecutionSessionLocator {
  readonly hostId: "local-codex" | "opencraft-server";
  readonly threadId: string;
  readonly inputId?: string;
  readonly turnId?: string;
  readonly executionId?: string;
  readonly incarnation?: string;
}
/** The Human Actor that owns a session phase, and the execution it was read from. */
export interface ExecutionSessionOwner {
  readonly hostId: ExecutionSessionLocator["hostId"];
  readonly threadId: string;
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly membershipRevision: number;
  readonly inputId: string;
  readonly executionId: string;
  readonly leaseGeneration: number;
  readonly turnId: string | null;
  readonly incarnation: string;
}
/** Core's session reader (`createHeadlessExecutionRecords().sessions`).
 * Synchronous SQLite: Worker only. `pending` is an admitted input before its
 * native Turn; `active` a started, unended Turn. */
export interface ExecutionSessionReader {
  owner(locator: unknown, phase: "active" | "pending"): ExecutionSessionOwner | null;
}
/** The original Human proof Main sends (`WorkspaceActorAdmission`). */
export interface PersonalMcpAdmission {
  readonly actorId: string;
  readonly generation: number;
  readonly membershipRevision: number;
  readonly expiresAt: number;
  readonly resourcePermit: Int32Array<SharedArrayBuffer>;
  readonly requestPermit: Int32Array<SharedArrayBuffer>;
}
/** Core's Actor/member recheck (`createHeadlessExecutionRecords().actors`). */
export interface PersonalMcpActors {
  /** Validates and freezes the proof's shape; throws when it is malformed or expired. */
  admit(raw: unknown): PersonalMcpAdmission;
  /** Whether the proof still matches committed Actor and member records. */
  current(access: PersonalMcpAdmission, pending: boolean): boolean;
}
export type PersonalMcpOperation =
  | { readonly kind: "catalog" }
  | { readonly kind: "call"; readonly name: string; readonly args: Record<string, unknown> };
export type PersonalMcpStatus =
  | { readonly state: "pending" }
  | { readonly state: "complete"; readonly value: unknown }
  | { readonly state: "failed"; readonly effect: "unknown" };
export interface PersonalMcpActor {
  readonly actorId: string;
  readonly generation: number;
}
/** Token presence only; the value never leaves the Worker. */
export interface PersonalMcpTokenState {
  readonly revision: number;
  readonly configured: boolean;
}
/** The Worker methods; a Main port is their async form. */
export interface PersonalMcpMethods {
  /** The Human Actor that owns this session for discovery or invocation. */
  personalMcpOwner(id: string, locator: ExecutionSessionLocator, invocation: boolean): PersonalMcpActor | null;
  personalMcpBegin(
    access: PersonalMcpAdmission,
    id: string,
    locator: ExecutionSessionLocator,
    operation: PersonalMcpOperation,
    permit: Int32Array<SharedArrayBuffer>,
  ): string;
  personalMcpStatus(
    access: PersonalMcpAdmission,
    id: string,
    locator: ExecutionSessionLocator,
    handle: string,
  ): PersonalMcpStatus;
  personalMcpCancel(handle: string): void;
  personalMcpForget(handle: string): void;
  personalMcpTokenState(access: PersonalMcpAdmission, id: string): PersonalMcpTokenState;
  /** Stores (revision 0), replaces or deletes (`null`) the caller's own token. */
  personalMcpTokenReplace(
    access: PersonalMcpAdmission,
    id: string,
    revision: number,
    token: string | null,
  ): PersonalMcpTokenState;
}
export interface PersonalMcpOwner {
  readonly methods: PersonalMcpMethods;
  close(): Promise<void>;
}
export type PersonalMcpPort = {
  [K in keyof PersonalMcpMethods]: (
    ...args: Parameters<PersonalMcpMethods[K]>
  ) => Promise<Awaited<ReturnType<PersonalMcpMethods[K]>>>;
};

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Validates and freezes a compiled service definition. */
export function personalMcpService(config: PersonalMcpService): PersonalMcpService {
  let endpoint: URL | undefined;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    /* Rejected below. */
  }
  if (
    !config ||
    !/^[a-z][a-z0-9-]{0,62}$/u.test(config.id) ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,30}_$/u.test(config.prefix) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(config.service) ||
    config.service.startsWith("document-") ||
    !endpoint ||
    endpoint.href !== config.endpoint ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback.has(endpoint.hostname))) ||
    !(config.tokenPattern instanceof RegExp) ||
    config.tokenPattern.global ||
    config.tokenPattern.sticky
  )
    throw new Error("Invalid personal MCP service");
  return Object.freeze({
    id: config.id,
    prefix: config.prefix,
    endpoint: config.endpoint,
    service: config.service,
    tokenPattern: new RegExp(config.tokenPattern.source, config.tokenPattern.flags),
  });
}
const accepts = (service: PersonalMcpService, token: unknown): token is string =>
  typeof token === "string" &&
  token.length > 0 &&
  token.length <= 4096 &&
  !/[\s\x00-\x1f\x7f]/u.test(token) &&
  token.match(service.tokenPattern)?.[0] === token;

const fail = (code: "forbidden" | "invalid" | "conflict" | "unconfigured" | "unavailable"): never => {
  throw new SandboxConfigurationError(
    code,
    code === "forbidden" ? 403 : code === "invalid" ? 400 : code === "conflict" ? 409 : 503,
  );
};
const live = (permit: unknown): permit is Int32Array<SharedArrayBuffer> =>
  permit instanceof Int32Array &&
  permit.buffer instanceof SharedArrayBuffer &&
  permit.length === 1 &&
  Atomics.load(permit, 0) === 1;
const locatorKey = (locator: ExecutionSessionLocator) =>
  JSON.stringify([
    locator.hostId,
    locator.threadId,
    locator.inputId,
    locator.turnId,
    locator.executionId,
    locator.incarnation,
  ]);
// Discovery may span the pending-to-active start of the same execution;
// invocation is pinned to the exact native Turn and lease generation.
const ownerKey = (owner: ExecutionSessionOwner, invocation: boolean) =>
  JSON.stringify([
    owner.hostId,
    owner.threadId,
    owner.actorId,
    owner.actorGeneration,
    owner.membershipRevision,
    owner.inputId,
    owner.executionId,
    ...(invocation ? [owner.leaseGeneration, owner.turnId, owner.incarnation] : []),
  ]);
function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(Error("MCP retired"));
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(Error("MCP retired"));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

type Job = {
  id: string;
  access: PersonalMcpAdmission;
  locator: string;
  permit: Int32Array<SharedArrayBuffer>;
  abort: AbortController;
  status: PersonalMcpStatus;
  work: Promise<void>;
  check(): void;
  forgotten: boolean;
  finished?: number;
};
const MAX_RESPONSE = 1024 * 1024;

/** The Worker-side personal MCP owner, inside the composition's sole vault
 * Worker. Tokens live in the vault's `actor:<actorId>` partition; the MCP SDK,
 * the token and the upstream network stay in this Worker. Handles are
 * ephemeral and bounded, not an outbox: uncertain effects are never retried,
 * and every request, response chunk and status read rechecks the Human
 * admission, the session's owner (through core's reader) and the token
 * revision. Close it before the session reader and the vault. */
export function createPersonalMcpOwner(options: {
  readonly vault: EmployeeGitVaultStore;
  readonly services: readonly PersonalMcpService[];
  readonly sessions: ExecutionSessionReader;
  readonly actors: PersonalMcpActors;
  /** Tests only: the transport the provider's fetch reaches. */
  readonly fetcher?: typeof fetch;
}): PersonalMcpOwner {
  const services = new Map<string, PersonalMcpService>();
  for (const raw of options.services) {
    const service = personalMcpService(raw);
    if (
      services.has(service.id) ||
      [...services.values()].some((other) => other.service === service.service || other.prefix === service.prefix)
    )
      throw new Error("Duplicate personal MCP service");
    services.set(service.id, service);
  }
  if (services.size === 0) throw new Error("Invalid personal MCP service");
  const { vault, sessions, actors } = options,
    fetcher = options.fetcher ?? fetch;
  const jobs = new Map<string, Job>();
  let closed = false,
    closing: Promise<void> | undefined;
  const sweep = setInterval(() => {
    for (const [handle, job] of jobs) if (job.finished && Date.now() - job.finished > 300_000) jobs.delete(handle);
  }, 1000);
  sweep.unref();

  const serviceOf = (id: unknown) => (typeof id === "string" && services.get(id)) || fail("unavailable");
  const admit = (raw: unknown) => {
    let access: PersonalMcpAdmission;
    try {
      access = actors.admit(raw);
    } catch {
      return fail("forbidden");
    }
    if (closed || !actors.current(access, true)) return fail("forbidden");
    return access;
  };
  const owner = (locator: unknown, invocation: boolean): ExecutionSessionOwner | null => {
    try {
      return sessions.owner(locator, "active") ?? (invocation ? null : sessions.owner(locator, "pending")) ?? null;
    } catch {
      return fail("unavailable");
    }
  };
  const guarded = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      if (error instanceof SandboxConfigurationError) throw error;
      if (error instanceof GitVaultError) return fail(error.code === "conflict" ? "conflict" : "invalid");
      // Store paths, payloads and SDK diagnostics never cross RPC.
      return fail("unavailable");
    }
  };
  const state = (access: PersonalMcpAdmission, service: PersonalMcpService): PersonalMcpTokenState => {
    const current = vault.readSecret(`actor:${access.actorId}`, service.service);
    return { revision: current.revision, configured: current.secret !== null };
  };

  function begin(
    rawAccess: PersonalMcpAdmission,
    id: string,
    rawLocator: ExecutionSessionLocator,
    rawOperation: PersonalMcpOperation,
    permit: Int32Array<SharedArrayBuffer>,
  ): string {
    if (closed || !live(permit) || jobs.size >= 64 || [...jobs.values()].filter((job) => !job.finished).length >= 16)
      return fail("unavailable");
    const service = serviceOf(id);
    const operation = structuredClone(rawOperation),
      locator = Object.freeze(structuredClone(rawLocator));
    if (
      !operation ||
      typeof operation !== "object" ||
      !["catalog", "call"].includes(operation.kind) ||
      Object.keys(operation).some((k) => !(operation.kind === "call" ? ["kind", "name", "args"] : ["kind"]).includes(k))
    )
      return fail("unavailable");
    if (
      operation.kind === "call" &&
      (typeof operation.name !== "string" ||
        !operation.name.startsWith(service.prefix) ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(operation.name) ||
        !operation.args ||
        typeof operation.args !== "object" ||
        Array.isArray(operation.args) ||
        Buffer.byteLength(JSON.stringify(operation.args)) > 65536)
    )
      return fail("unavailable");
    const access = admit(rawAccess),
      invocation = operation.kind === "call";
    const initialOwner = owner(locator, invocation);
    if (
      !initialOwner ||
      initialOwner.actorId !== access.actorId ||
      initialOwner.actorGeneration !== access.generation ||
      initialOwner.membershipRevision !== access.membershipRevision
    )
      return fail("unavailable");
    const account = `actor:${access.actorId}`,
      fence = ownerKey(initialOwner, invocation);
    const initial = vault.readSecret(account, service.service);
    if (!accepts(service, initial.secret)) return fail("unconfigured");
    const handle = randomBytes(32).toString("hex"),
      abort = new AbortController();
    const current = (): McpCredential => {
      if (closed || abort.signal.aborted || !live(permit) || !actors.current(access, true)) return fail("unavailable");
      const now = owner(locator, invocation);
      if (!now || ownerKey(now, invocation) !== fence) return fail("unavailable");
      const secret = vault.readSecret(account, service.service);
      if (secret.revision !== initial.revision || !accepts(service, secret.secret)) return fail("unavailable");
      return { account, revision: secret.revision, token: secret.secret, executionId: now.executionId };
    };
    const job: Job = {
      id: service.id,
      access,
      locator: locatorKey(locator),
      permit,
      abort,
      status: { state: "pending" },
      work: Promise.resolve(),
      check: () => void current(),
      forgotten: false,
    };
    jobs.set(handle, job);
    const provider = new AuthenticatedMcpProvider({
      id: service.id,
      prefix: service.prefix,
      endpoint: service.endpoint,
      resolve: () => current(),
      fetcher: async (input, init) => {
        current();
        const pending = fetcher(input, {
          ...init,
          signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
        });
        void pending.then(
          (response) => {
            if (abort.signal.aborted) void response.body?.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await aborted(pending, abort.signal);
        try {
          current();
        } catch (error) {
          void response.body?.cancel().catch(() => {});
          throw error;
        }
        if (!response.body) return response;
        const reader = response.body.getReader();
        let bytes = 0;
        // Every chunk is bounded and read only while the session, Actor and
        // token revision are still the ones this operation began with.
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              current();
              const chunk = await aborted(reader.read(), abort.signal);
              current();
              if (chunk.done) {
                reader.releaseLock();
                controller.close();
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > MAX_RESPONSE) throw Error("MCP response limit");
              controller.enqueue(chunk.value);
            } catch {
              void reader.cancel().catch(() => {});
              controller.error(Error("MCP unavailable"));
            }
          },
          cancel: () => reader.cancel(),
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    // The provider only passes this to `resolve`, which ignores it: the
    // operation is bound to the locator read above.
    const session: CapabilitySession = Object.freeze({
      serverId: `personal-mcp:${service.id}`,
      threadId: locator.threadId,
      execution: Object.freeze({ inputId: initialOwner.inputId, executionId: initialOwner.executionId }),
    });
    const deadline = setTimeout(() => abort.abort(), 60_000);
    deadline.unref();
    const watch = setInterval(() => {
      try {
        current();
      } catch {
        abort.abort();
      }
    }, 50);
    watch.unref();
    job.work = Promise.resolve().then(async () => {
      try {
        current();
        await provider.refresh(session);
        current();
        const value =
          operation.kind === "catalog"
            ? provider.tools(session)
            : await provider.call(session, operation.name, operation.args, abort.signal);
        current();
        if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_RESPONSE) return fail("unavailable");
        job.status = { state: "complete", value };
      } catch {
        job.status = { state: "failed", effect: "unknown" };
      } finally {
        clearTimeout(deadline);
        clearInterval(watch);
        job.finished = Date.now();
        if (job.forgotten) jobs.delete(handle);
      }
    });
    return handle;
  }
  const cancel = (handle: string) => {
    const job = jobs.get(handle);
    if (job) {
      Atomics.store(job.permit, 0, 0);
      job.abort.abort();
    }
  };

  return {
    methods: {
      personalMcpOwner: (id, locator, invocation) =>
        guarded(() => {
          serviceOf(id);
          if (closed || typeof invocation !== "boolean") return fail("unavailable");
          const current = owner(structuredClone(locator), invocation);
          return current ? { actorId: current.actorId, generation: current.actorGeneration } : null;
        }),
      personalMcpBegin: (access, id, locator, operation, permit) =>
        guarded(() => begin(access, id, locator, operation, permit)),
      personalMcpStatus: (rawAccess, id, locator, handle) =>
        guarded(() => {
          const job = typeof handle === "string" ? jobs.get(handle) : undefined;
          if (
            !job ||
            closed ||
            job.id !== id ||
            !locator ||
            job.locator !== locatorKey(locator) ||
            rawAccess?.actorId !== job.access.actorId ||
            rawAccess.generation !== job.access.generation ||
            rawAccess.membershipRevision !== job.access.membershipRevision
          )
            return fail("unavailable");
          admit(rawAccess);
          if (!live(job.permit)) return { state: "failed", effect: "unknown" };
          // A finished output cannot outlive its execution or token revision.
          if (job.status.state !== "failed") job.check();
          return job.status;
        }),
      personalMcpCancel: (handle) => cancel(handle),
      personalMcpForget: (handle) => {
        const job = jobs.get(handle);
        if (!job) return;
        if (job.finished) jobs.delete(handle);
        else {
          job.forgotten = true;
          cancel(handle);
        }
      },
      personalMcpTokenState: (rawAccess, id) =>
        guarded(() => {
          const service = serviceOf(id),
            access = admit(rawAccess),
            value = state(access, service);
          if (!actors.current(access, true)) return fail("forbidden");
          return value;
        }),
      personalMcpTokenReplace: (rawAccess, id, revision, raw) =>
        guarded(() => {
          const service = serviceOf(id),
            access = admit(rawAccess);
          const token = typeof raw === "string" ? raw.trim() : raw;
          if (!Number.isSafeInteger(revision) || revision < 0) return fail("invalid");
          if (token !== null && !accepts(service, token)) return fail("invalid");
          // The write is fenced by the same committed Actor/member records.
          if (!actors.current(access, true)) return fail("forbidden");
          const written = vault.writeSecret(`actor:${access.actorId}`, service.service, revision, token);
          return { revision: written.revision, configured: written.configured };
        }),
    },
    close() {
      if (closing) return closing;
      closed = true;
      clearInterval(sweep);
      for (const handle of jobs.keys()) cancel(handle);
      return (closing = Promise.allSettled([...jobs.values()].map((job) => job.work)).then(() => {
        jobs.clear();
      }));
    },
  };
}
