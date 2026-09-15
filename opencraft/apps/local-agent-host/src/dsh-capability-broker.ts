import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { DshExecutionOwner } from "./dsh-execution-authority.js";

export interface DshHostCapability {
  readonly id: string;
  readonly namespace: string | null;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
type Send = (frame: Record<string, unknown>) => void;
interface Registration { owner: DshExecutionOwner; send: Send; capabilities: readonly DshHostCapability[] }
interface Pending { registration: Registration; threadId: string; reject: (error: Error) => void; respond: (result: unknown, error?: unknown) => void }

/** Host half of HyperNode capability-request/result/cancel, addressed only to
 * the connection that registered the capability for this execution's Thread.
 */
export class DshCapabilityBroker {
  private registrations = new Map<string, Registration>();
  private pending = new Map<string, Pending>();
  constructor(private readonly timeoutMs = 10_000) {}
  register(threadId: string, owner: DshExecutionOwner, specs: unknown, send: Send): readonly DshHostCapability[] {
    const previous = this.registrations.get(threadId);
    if (previous && previous.owner !== owner) throw new Error("Thread capabilities belong to another connection");
    const capabilities = normalizeCapabilities(specs);
    if (previous && isDeepStrictEqual(previous.capabilities, capabilities)) return previous.capabilities;
    if (previous) this.cancelThread(threadId, "Capabilities replaced");
    this.registrations.set(threadId, { owner, send, capabilities });
    return capabilities;
  }
  matches(threadId: string, owner: DshExecutionOwner, specs: unknown): boolean {
    const previous = this.registrations.get(threadId);
    return !!previous && previous.owner === owner && isDeepStrictEqual(previous.capabilities, normalizeCapabilities(specs));
  }
  list(threadId: string): readonly DshHostCapability[] { return this.registrations.get(threadId)?.capabilities ?? []; }
  threads(owner?: DshExecutionOwner): string[] {
    return [...this.registrations].filter(([, value]) => !owner || value.owner === owner).map(([id]) => id);
  }
  invoke(threadId: string, turnId: string, capabilityId: string, args: unknown, signal: AbortSignal, owner: DshExecutionOwner): Promise<unknown> {
    const registration = this.registrations.get(threadId);
    if (!registration || registration.owner !== owner) return Promise.reject(new Error("No capability owner for this execution"));
    const capability = registration.capabilities.find(value => value.id === capabilityId);
    if (!capability) return Promise.reject(new Error("Capability is not registered for this thread"));
    if (signal.aborted) return Promise.reject(new Error("Capability call cancelled"));
    const id = "dsh-capability-" + randomUUID();
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const cancel = (error: Error) => {
        clean();
        try { registration.send({ method: "serverRequest/resolved", params: { threadId, requestId: id } }); } finally { reject(error); }
      };
      const abort = () => cancel(new Error("Capability call cancelled"));
      const timer = setTimeout(() => cancel(new Error("Capability call timed out")), this.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        registration, threadId, reject: cancel,
        respond: (result, error) => {
          clean();
          if (error) reject(new Error("Host capability failed"));
          else resolve(result);
        },
      });
      try {
        registration.send({ id, method: "item/tool/call", params: {
          threadId, turnId, callId: id, namespace: capability.namespace,
          tool: capability.name, arguments: args,
        } });
      } catch (error) { clean(); reject(error); }
    });
  }
  respond(owner: DshExecutionOwner, id: string, result: unknown, error?: unknown): boolean {
    const call = this.pending.get(id);
    if (!call || call.registration.owner !== owner) return false;
    call.respond(result, error);
    return true;
  }
  private cancelThread(threadId: string, reason: string) {
    for (const call of [...this.pending.values()]) if (call.threadId === threadId) call.reject(new Error(reason));
  }
  disconnect(owner: DshExecutionOwner): void {
    for (const [threadId, registration] of this.registrations) if (registration.owner === owner) {
      this.cancelThread(threadId, "Capability owner disconnected");
      this.registrations.delete(threadId);
    }
  }
  close(): void {
    for (const call of [...this.pending.values()]) call.reject(new Error("Capability broker closed"));
    this.registrations.clear();
  }
}

export function normalizeCapabilities(specs: unknown): DshHostCapability[] {
    if (!Array.isArray(specs)) throw new Error("dynamicTools must be an array");
    const capabilities: DshHostCapability[] = [];
    const ids = new Set<string>();
    const add = (namespace: string | null, tool: any) => {
      if (typeof tool?.name !== "string" || !tool.name || typeof tool.description !== "string" ||
          !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("Invalid dynamic tool specification");
      const id = namespace ? namespace + "." + tool.name : tool.name;
      if (ids.has(id)) throw new Error("Duplicate dynamic capability: " + id);
      ids.add(id);
      capabilities.push({ id, namespace, name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) });
    };
    for (const spec of specs) {
      if (spec?.type === "function") add(null, spec);
      else if (spec?.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
        for (const tool of spec.tools) add(spec.name, tool);
      } else throw new Error("Invalid dynamic tool specification");
    }
    return capabilities;
}
