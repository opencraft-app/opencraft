import type { ConnectorScope } from "./contract";

export interface ConnectorWriteRequest extends ConnectorScope {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly connectorTitle: string;
  readonly tool: string;
  readonly description: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface ConnectorApproval extends Omit<ConnectorWriteRequest, "arguments"> {
  readonly id: string;
  readonly argumentsPreview: string;
}
export interface ConnectorApprovalPort {
  request(input: ConnectorWriteRequest, signal: AbortSignal): Promise<boolean>;
}

function preview(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested content]";
  if (Array.isArray(value)) return value.slice(0, 50).map(item => preview(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /token|secret|password|authorization|api.?key|credential/i.test(key) ? "[redacted]" : preview(item, depth + 1)]));
  return value;
}

/** One-shot UI decisions, never a persisted grant. Parameters remain bound in the caller. */
export class ConnectorApprovalQueue implements ConnectorApprovalPort {
  private readonly entries = new Map<string, { value: ConnectorApproval; finish(allow: boolean): void }>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly ConnectorApproval[] = Object.freeze([]);
  private disposed = false;
  constructor(private readonly timeoutMs = 60000) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  request(input: ConnectorWriteRequest, signal: AbortSignal): Promise<boolean> {
    if (this.disposed || signal.aborted || this.entries.size >= 32) return Promise.resolve(false);
    const { arguments: args, ...identity } = input;
    const id = crypto.randomUUID();
    const value = Object.freeze({ ...identity, id, argumentsPreview: JSON.stringify(preview(args), null, 2).slice(0, 12000) });
    return new Promise(resolve => {
      let finished = false;
      const finish = (allow: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
        this.entries.delete(id); this.publish(); resolve(allow && !signal.aborted);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, this.timeoutMs);
      this.entries.set(id, { value, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else this.publish();
    });
  }
  respond(id: string, allow: boolean): void { this.entries.get(id)?.finish(allow); }
  dispose(): void { this.disposed = true; for (const entry of [...this.entries.values()]) entry.finish(false); this.listeners.clear(); }
  private publish() { this.snapshot = Object.freeze([...this.entries.values()].map(e => e.value)); for (const listener of this.listeners) listener(); }
}
