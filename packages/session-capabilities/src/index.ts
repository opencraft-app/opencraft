/** Trusted Host composition supplies the session; model arguments never select it. */
export interface CapabilitySession { readonly serverId: string; readonly threadId: string }
export interface CapabilityTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Trusted domain consent already covers this bounded invocation; never model supplied. */
  readonly approval?: "preauthorized";
}
export interface CapabilityResult { success: boolean; contentItems: { type: "inputText"; text: string }[] }
export interface SessionCapabilityProvider {
  readonly id: string;
  tools(session: CapabilitySession): readonly CapabilityTool[];
  formatResult?(value: unknown): CapabilityResult;
  call(session: CapabilitySession, name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}
export interface SessionCapabilityPort {
  refresh?(threadId: string): Promise<void>;
  tools(threadId: string): readonly CapabilityTool[];
  call(threadId: string, name: string, args: unknown, signal: AbortSignal): Promise<CapabilityResult>;
}

/** Policy/catalog and invocation share the same provider lookup, on every call.
 * Providers retain domain authorization, durable effect receipts and recovery.
 */
export class SessionCapabilities {
  private readonly providers = new Map<string, SessionCapabilityProvider>();
  register(provider: SessionCapabilityProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error("Capability provider already registered");
    this.providers.set(provider.id, provider);
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); };
  }
  private catalog(session: CapabilitySession) {
    const tools = new Map<string, { tool: CapabilityTool; provider: SessionCapabilityProvider }>();
    for (const provider of this.providers.values()) for (const tool of provider.tools(session)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(tool.name) || tools.has(tool.name)) throw new Error("Capability name conflict");
      tools.set(tool.name, { tool: structuredClone(tool), provider });
    }
    return tools;
  }
  tools(session: CapabilitySession): readonly CapabilityTool[] { return [...this.catalog(session).values()].map(v => v.tool); }
  async call(session: CapabilitySession, name: string, args: unknown, signal: AbortSignal): Promise<CapabilityResult> {
    signal.throwIfAborted();
    const entry = this.catalog(session).get(name);
    if (!entry) throw new Error("Capability is not authorized for this session");
    const value = await entry.provider.call(Object.freeze({ ...session }), name, args, signal);
    if (entry.provider.formatResult) return entry.provider.formatResult(value);
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) ?? "null" }] };
  }
  scoped(serverId: string): SessionCapabilityPort {
    return { tools: threadId => this.tools({ serverId, threadId }),
      call: (threadId, name, args, signal) => this.call({ serverId, threadId }, name, args, signal) };
  }
}
