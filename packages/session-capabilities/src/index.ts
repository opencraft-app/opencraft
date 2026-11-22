/** Trusted Host composition supplies the session; model arguments never select it. */
export interface CapabilityExecution {
  readonly executionId?: string; readonly inputId?: string; readonly turnId?: string; readonly incarnation?: string; readonly callId?: string;
}
/** Execution Host that owns the session's server, as routed by core. */
export interface CapabilityExecutionHost {
  /** Core Host id, for example `local-codex` or `opencraft-server`. */
  readonly id: string;
  /** Native engine behind the server (`codex`, `dsh`, `pi`, ...). */
  readonly engine: string;
}
/** Verified human Actor that admitted the current run. Resource ownership and
 * credentials key on the Actor; `bindings` are its verified login identities. */
export interface CapabilityActor {
  readonly id: string;
  readonly generation: number;
  readonly bindings: readonly { readonly provider: string; readonly subject: string }[];
}
/** Active execution lease the run currently holds. */
export interface CapabilityLease {
  readonly inputId: string;
  readonly executionId: string;
  readonly generation: number;
  readonly turnId: string;
  readonly incarnation: string;
}
/** Core-resolved execution context. Providers read it instead of parsing
 * `serverId` or opening core stores. Each part is absent when core cannot
 * verify it for this run: no Host route, no admitted human (bot/unowned runs,
 * revoked or expired authority), or no active lease (pending, ended, or an
 * installation without the lease owner). It is never a default and never
 * accepted from a caller: `SessionCapabilities` strips any supplied value and
 * attaches only what its configured resolver returns. */
export interface CapabilityExecutionContext {
  readonly host: CapabilityExecutionHost;
  readonly actor?: CapabilityActor;
  readonly lease?: CapabilityLease;
}
export interface CapabilitySession {
  readonly serverId: string; readonly threadId: string; readonly execution?: CapabilityExecution;
  /** Set by `SessionCapabilities` only; see `CapabilityExecutionContext`. */
  readonly context?: CapabilityExecutionContext;
}
/** Trusted composition resolves context from core admission/lease owners.
 * Must not block the event loop; return undefined when the route is unknown. */
export type CapabilityContextResolver = (
  session: Omit<CapabilitySession, "context">,
) => Promise<CapabilityExecutionContext | undefined>;
export interface CapabilityTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Trusted domain consent already covers this bounded invocation; never model supplied. */
  readonly approval?: "preauthorized";
}
export type CapabilityContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };
export interface CapabilityResult { success: boolean; contentItems: CapabilityContentItem[] }
export interface SessionCapabilityProvider {
  readonly id: string;
  refresh?(session: CapabilitySession): Promise<void>;
  tools(session: CapabilitySession): readonly CapabilityTool[];
  formatResult?(value: unknown): CapabilityResult;
  call(session: CapabilitySession, name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}
export interface SessionCapabilityPort {
  refresh?(threadId: string, execution?: CapabilityExecution, signal?: AbortSignal): Promise<void>;
  tools(threadId: string): readonly CapabilityTool[];
  call(threadId: string, name: string, args: unknown, signal: AbortSignal, execution?: CapabilityExecution): Promise<CapabilityResult>;
}

/** Policy/catalog and invocation share the same provider lookup, on every call.
 * Providers retain domain authorization, durable effect receipts and recovery.
 */
export class SessionCapabilities {
  private readonly providers = new Map<string, SessionCapabilityProvider>();
  private resolver: CapabilityContextResolver | undefined;
  /** Context from the latest refresh, for the synchronous catalog only. */
  private readonly prepared = new Map<string, CapabilityExecutionContext | undefined>();
  /** Installed once by trusted Host composition. */
  resolveContext(resolver: CapabilityContextResolver): void {
    if (this.resolver) throw new Error("Capability context resolver already installed");
    this.resolver = resolver;
  }
  private static identity(session: CapabilitySession): Omit<CapabilitySession, "context"> {
    return Object.freeze({ serverId: session.serverId, threadId: session.threadId,
      ...(session.execution ? { execution: Object.freeze({ ...session.execution }) } : {}) });
  }
  private static key(session: CapabilitySession): string {
    const { callId: _callId, ...execution } = session.execution ?? {};
    return JSON.stringify([session.serverId, session.threadId, execution]);
  }
  private static attach(session: Omit<CapabilitySession, "context">, context: CapabilityExecutionContext | undefined): CapabilitySession {
    return context ? Object.freeze({ ...session, context }) : session;
  }
  private async resolved(session: CapabilitySession): Promise<CapabilitySession> {
    const identity = SessionCapabilities.identity(session);
    const context = await this.resolver?.(identity);
    return SessionCapabilities.attach(identity, context ? freezeContext(context) : undefined);
  }
  register(provider: SessionCapabilityProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error("Capability provider already registered");
    this.providers.set(provider.id, provider);
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); };
  }
  async refresh(session: CapabilitySession): Promise<void> {
    const current = await this.resolved(session), key = SessionCapabilities.key(current);
    this.prepared.delete(key);
    if (this.prepared.size >= 256) this.prepared.delete(this.prepared.keys().next().value!);
    this.prepared.set(key, current.context);
    await Promise.all([...this.providers.values()].map(provider => provider.refresh?.(current)));
  }
  private catalog(session: CapabilitySession) {
    const tools = new Map<string, { tool: CapabilityTool; provider: SessionCapabilityProvider }>();
    for (const provider of this.providers.values()) for (const tool of provider.tools(session)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(tool.name) || tools.has(tool.name)) throw new Error("Capability name conflict");
      tools.set(tool.name, { tool: structuredClone(tool), provider });
    }
    return tools;
  }
  /** Synchronous catalog: context is the one resolved by the latest refresh of
   * the same execution (absent without one). Every call resolves it afresh. */
  tools(session: CapabilitySession): readonly CapabilityTool[] {
    const identity = SessionCapabilities.identity(session);
    return [...this.catalog(SessionCapabilities.attach(identity, this.prepared.get(SessionCapabilities.key(identity)))).values()].map(v => v.tool);
  }
  async call(session: CapabilitySession, name: string, args: unknown, signal: AbortSignal): Promise<CapabilityResult> {
    signal.throwIfAborted();
    const current = await this.resolved(session);
    signal.throwIfAborted();
    const entry = this.catalog(current).get(name);
    if (!entry) throw new Error("Capability is not authorized for this session");
    const value = await entry.provider.call(current, name, args, signal);
    signal.throwIfAborted();
    if (entry.provider.formatResult) return entry.provider.formatResult(value);
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) ?? "null" }] };
  }
  scoped(serverId: string): SessionCapabilityPort {
    const prepared = new Map<string, CapabilityExecution | undefined>();
    return {
      refresh: async (threadId, execution) => {
        prepared.delete(threadId);
        await this.refresh({ serverId, threadId, execution });
        if (prepared.size >= 256) prepared.delete(prepared.keys().next().value!);
        prepared.set(threadId, execution ? Object.freeze({ ...execution }) : undefined);
      },
      tools: threadId => this.tools({ serverId, threadId, execution: prepared.get(threadId) }),
      // Invocation context always comes from the native call, never the last catalog refresh.
      call: (threadId, name, args, signal, execution) => this.call({ serverId, threadId, execution }, name, args, signal),
    };
  }
}

function freezeContext(context: CapabilityExecutionContext): CapabilityExecutionContext {
  return Object.freeze({
    host: Object.freeze({ id: context.host.id, engine: context.host.engine }),
    ...(context.actor ? { actor: Object.freeze({ id: context.actor.id, generation: context.actor.generation,
      bindings: Object.freeze(context.actor.bindings.map(binding => Object.freeze({ provider: binding.provider, subject: binding.subject }))) }) } : {}),
    ...(context.lease ? { lease: Object.freeze({ inputId: context.lease.inputId, executionId: context.lease.executionId,
      generation: context.lease.generation, turnId: context.lease.turnId, incarnation: context.lease.incarnation }) } : {}),
  });
}
