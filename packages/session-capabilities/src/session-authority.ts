import type { CapabilityBindingStore } from "./bindings.js";
import type { CapabilityExecution, CapabilitySession, CapabilityTool, SessionCapabilities } from "./index.js";

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const hostId = (value: unknown): value is string => id(value) && !/[\x00-\x1f\x7f]/u.test(value);
const executionFields = ["executionId", "inputId", "turnId", "incarnation", "callId"];

function execution(value: unknown): CapabilityExecution | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !executionFields.includes(key)) ||
    !Object.values(value).every(id)
  )
    return null;
  return Object.freeze(value as CapabilityExecution);
}

export function sessionCapabilityClaims(session: CapabilitySession): readonly unknown[] {
  return session.execution
    ? ["execution", session.serverId, session.threadId, session.execution]
    : ["session", session.serverId, session.threadId];
}

export function executionCliClaimsSession(claims: unknown): CapabilitySession | null {
  if (
    !Array.isArray(claims) ||
    claims.length !== 4 ||
    claims[0] !== "execution-cli" ||
    !id(claims[1]) ||
    !id(claims[2])
  )
    return null;
  const source = execution(claims[3]);
  return source?.inputId && source.executionId ? { serverId: claims[1], threadId: claims[2], execution: source } : null;
}

export type HostGitSource =
  { readonly inputId: string; readonly turnId?: never } | { readonly turnId: string; readonly inputId?: never };

export function parseHostGitSource(value: unknown): HostGitSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("git_execution_unavailable");
  const keys = Object.keys(value);
  const source = value as Record<string, unknown>;
  if (keys.length === 1 && keys[0] === "inputId" && hostId(source.inputId))
    return Object.freeze({ inputId: source.inputId });
  if (keys.length === 1 && keys[0] === "turnId" && hostId(source.turnId))
    return Object.freeze({ turnId: source.turnId });
  throw new Error("git_execution_unavailable");
}

export interface CapabilityAuthentication {
  readonly session: CapabilitySession | null;
  readonly tools?: readonly CapabilityTool[];
  readonly reservationId?: string;
  readonly executionReservation?: Promise<CapabilitySession>;
  readonly nativeTool?: boolean;
}

export type CapabilityRequestAudience = "mcp" | "session" | "execution-cli" | "host-git" | "host-environment";

export class CapabilityInvocationFault extends Error {
  constructor(
    readonly stage: "authentication" | "binding" | "dispatch",
    cause?: unknown,
  ) {
    super("Capability invocation unavailable", { cause });
  }
}

interface ExecutionReservation {
  bound: Promise<CapabilitySession>;
  resolve(session: CapabilitySession): void;
  session?: CapabilitySession;
  scope?: CapabilitySession;
  readonly expiresAt: number;
  readonly memoryOnly: boolean;
}

interface CredentialDeclaration {
  readonly claims: readonly unknown[];
  readonly tools: readonly CapabilityTool[];
}

function executionWaiter() {
  let resolve!: (session: CapabilitySession) => void;
  const bound = new Promise<CapabilitySession>((done) => {
    resolve = done;
  });
  return { bound, resolve };
}

/** Binding and claim policy for the session owner. The transport verifies signatures
 * before passing claims here. Providers still authorize each actual invocation. */
export class CapabilitySessionAuthority {
  private readonly pending = new Map<string, { tools: readonly CapabilityTool[]; expiresAt: number }>();
  private readonly memoryBindings = new Map<string, CapabilitySession>();
  private readonly executions = new Map<string, ExecutionReservation>();

  constructor(
    private readonly capabilities: SessionCapabilities,
    private readonly bindings?: CapabilityBindingStore,
  ) {}

  authenticate(requested: CapabilityRequestAudience, claims: unknown): CapabilityAuthentication | null {
    if (!Array.isArray(claims)) return null;
    const [audience, first, second, source] = claims as unknown[];
    if (audience === "host-git" || audience === "host-environment") {
      if (requested !== audience || claims.length !== 4 || !hostId(first) || !hostId(second)) return null;
      try {
        return { session: Object.freeze({ serverId: first, threadId: second, execution: parseHostGitSource(source) }) };
      } catch {
        return null;
      }
    }
    if (requested === "host-git" || requested === "host-environment") return null;

    const cli = requested === "execution-cli";
    if (audience === "execution-cli") {
      const session = cli ? executionCliClaimsSession(claims) : null;
      return session ? { session } : null;
    }
    if (cli) return null;

    if ((audience === "execution" || audience === "native-tool") && claims.length === 4) {
      if (!id(first) || !id(second)) return null;
      const target = execution(source);
      if (
        !target ||
        (!target.inputId && !target.turnId) ||
        (audience === "native-tool" && (requested !== "mcp" || !target.callId))
      )
        return null;
      return {
        session: Object.freeze({ serverId: first, threadId: second, execution: target }),
        nativeTool: audience === "native-tool",
      };
    }
    if (!claims.every(id) || !id(first)) return null;
    if ((audience === "execution-binding" || audience === "execution-memory-binding") && claims.length === 2) {
      const reserved =
        audience === "execution-memory-binding" ? this.executions.get(first) : this.executionReservation(first);
      if (!reserved || (!reserved.scope && !reserved.session && reserved.expiresAt <= Date.now())) return null;
      return { session: reserved.session ?? null, executionReservation: reserved.bound };
    }
    if (audience === "binding" && claims.length === 2) {
      const session = this.bindings?.get(first) ?? this.memoryBindings.get(first);
      if (session) return { session, reservationId: first };
      const pending = this.pending.get(first);
      return pending && pending.expiresAt > Date.now() ? { session: null, tools: pending.tools } : null;
    }
    return audience === "session" && claims.length === 3 && id(second)
      ? { session: Object.freeze({ serverId: first, threadId: second }) }
      : null;
  }

  declaration(session: CapabilitySession): CredentialDeclaration | null {
    const tools = this.capabilities.tools(session);
    if (!tools.length) return null;
    const bound = session.execution
      ? undefined
      : (this.bindings?.id(session) ??
        [...this.memoryBindings].find(
          ([, entry]) => entry.serverId === session.serverId && entry.threadId === session.threadId,
        )?.[0]);
    return { claims: bound ? ["binding", bound] : sessionCapabilityClaims(session), tools };
  }

  prepare(tools: readonly CapabilityTool[]) {
    for (const [key, entry] of this.pending) if (entry.expiresAt <= Date.now()) this.pending.delete(key);
    if (this.pending.size >= 128) throw new Error("Too many pending capability reservations");
    const key = crypto.randomUUID();
    this.pending.set(key, { tools: structuredClone(tools), expiresAt: Date.now() + 60_000 });
    return {
      claims: ["binding", key] as const,
      tools,
      bind: (session: CapabilitySession) => {
        const pending = this.pending.get(key);
        if (!pending || pending.expiresAt <= Date.now() || this.bindings?.get(key) || this.memoryBindings.has(key))
          throw new Error("Capability reservation expired or already bound");
        if (this.bindings) this.bindings.bind(key, session);
        else this.memoryBindings.set(key, Object.freeze({ ...session }));
      },
      cancel: () => {
        this.pending.delete(key);
      },
    };
  }

  private executionReservation(key: string) {
    const existing = this.executions.get(key);
    if (existing) return existing;
    const saved = this.bindings?.execution(key);
    if (!saved) return undefined;
    const reservation: ExecutionReservation = { ...executionWaiter(), expiresAt: Infinity, memoryOnly: false };
    reservation.scope = saved.scope;
    if (saved.session) {
      reservation.session = saved.session;
      reservation.resolve(saved.session);
    }
    this.executions.set(key, reservation);
    return reservation;
  }

  private executionHandle(key: string, reservation: ExecutionReservation, tools: readonly CapabilityTool[] = []) {
    return {
      claims: [reservation.memoryOnly ? "execution-memory-binding" : "execution-binding", key] as const,
      tools,
      bindThread: (scope: CapabilitySession) => {
        if (this.executions.get(key) !== reservation || reservation.scope || reservation.expiresAt <= Date.now())
          throw new Error("Execution capability reservation is unavailable");
        if (!reservation.memoryOnly) this.bindings?.prepareExecution(key, scope);
        reservation.scope = { serverId: scope.serverId, threadId: scope.threadId };
      },
      bind: (session: CapabilitySession) => {
        const scope = reservation.scope;
        if (
          this.executions.get(key) !== reservation ||
          (!scope && reservation.expiresAt <= Date.now()) ||
          !session.execution?.inputId ||
          !session.execution.executionId ||
          (scope && (scope.serverId !== session.serverId || scope.threadId !== session.threadId))
        )
          throw new Error("Execution capability reservation is unavailable");
        if (reservation.session) {
          if (JSON.stringify(reservation.session) !== JSON.stringify(session))
            throw new Error("Execution capability reservation is already bound");
          return;
        }
        if (scope && !reservation.memoryOnly) this.bindings?.bindExecution(key, session);
        reservation.session = structuredClone(session);
        reservation.resolve(reservation.session);
      },
      resetBeforeStart: () => {
        if (!reservation.memoryOnly) throw new Error("Only an unstarted bridge binding can reset");
        reservation.session = undefined;
        Object.assign(reservation, executionWaiter());
      },
      cancel: () => {
        try {
          if (!reservation.memoryOnly) this.bindings?.removeExecution(key);
        } finally {
          this.executions.delete(key);
        }
      },
    };
  }

  prepareExecution(options: { memoryOnly?: boolean; scope?: CapabilitySession } = {}) {
    for (const [key, entry] of this.executions)
      if (!entry.scope && !entry.session && entry.expiresAt <= Date.now()) this.executions.delete(key);
    if ([...this.executions.values()].filter((entry) => !entry.memoryOnly || !entry.scope).length >= 256)
      throw new Error("Too many pending execution capability reservations");
    const key = crypto.randomUUID();
    const reserved: ExecutionReservation = {
      ...executionWaiter(),
      expiresAt: Date.now() + 60_000,
      memoryOnly: options.memoryOnly === true,
    };
    this.executions.set(key, reserved);
    return this.executionHandle(key, reserved, options.scope ? this.capabilities.tools(options.scope) : []);
  }

  restoreExecution(scope: CapabilitySession) {
    const key = this.bindings?.executionId(scope);
    const reserved = key ? this.executionReservation(key) : undefined;
    return key && reserved ? this.executionHandle(key, reserved) : null;
  }

  /** A pre-creation declaration can be listed while binding completes. Calls always need a bound session. */
  async list(authentication: CapabilityAuthentication, signal: AbortSignal) {
    let session = authentication.session;
    if (!session && authentication.executionReservation) {
      session = await new Promise<CapabilitySession>((resolve, reject) => {
        const abort = () => reject(new Error("Capability declaration wait was cancelled"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        void authentication.executionReservation!.then((value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
    }
    if (session) await this.capabilities.refresh(session);
    const tools = session ? this.capabilities.tools(session) : (authentication.tools ?? []);
    const key = authentication.reservationId;
    const staged = key ? this.pending.get(key) : undefined;
    if (tools.length && key) this.pending.delete(key);
    const visible = tools.length ? tools : staged && staged.expiresAt > Date.now() ? staged.tools : [];
    return { tools: visible.map(({ approval: _approval, ...tool }) => tool) };
  }

  async call(
    authentication: CapabilityAuthentication,
    recheck: () => CapabilityAuthentication | null,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ) {
    const current = recheck();
    if (!current || JSON.stringify(current.session) !== JSON.stringify(authentication.session))
      throw new CapabilityInvocationFault("authentication");
    const session = authentication.session;
    if (!session) throw new CapabilityInvocationFault("binding");
    // Transport request IDs are client-local. An ordinary invocation receives
    // a fresh identity. The signed native-tool audience already binds its call.
    const invocation =
      session.execution && !authentication.nativeTool
        ? {
            ...session,
            execution: {
              ...session.execution,
              callId: JSON.stringify([session.execution.callId ?? null, crypto.randomUUID()]),
            },
          }
        : session;
    try {
      return await this.capabilities.call(invocation, name, args, signal);
    } catch (error) {
      throw new CapabilityInvocationFault("dispatch", error);
    }
  }

  close() {
    this.executions.clear();
    this.pending.clear();
    this.memoryBindings.clear();
  }
}
