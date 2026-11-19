import type { DuplexTransport, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { OPENCRAFT_METHOD_ACCESS_EXTENSION } from "@opencraft/appserver-protocol";
import { HOST_FILESYSTEM_METHODS, type HostFileSystem } from "./host-filesystem.js";

/** Selected Host files never fall through to an engine's controller filesystem. */
export class HostFileSystemSession {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly initializing = new Set<string>();
  private readonly clients = new Set<string>();
  private readonly active = new Map<AbortController, string>();
  private closed = false;
  constructor(
    private readonly files: HostFileSystem,
    private readonly authorize: (context: TransportSubmissionContext) => void,
  ) {}
  project(frame: string): string | null {
    const value = JSON.parse(frame),
      client = String(value[LOGICAL_CLIENT_FIELD] ?? "");
    if (this.initializing.delete(JSON.stringify([client, value.id])) && !value.error) {
      this.clients.add(client);
      const extensions = value.result?.capabilities?.extensions,
        access = extensions?.[OPENCRAFT_METHOD_ACCESS_EXTENSION];
      if (Array.isArray(access?.methods))
        access.methods = [
          ...new Set([
            ...access.methods.filter((method: string) => !method.startsWith("fs/")),
            ...HOST_FILESYSTEM_METHODS,
          ]),
        ];
    }
    if (typeof value.method === "string" && value.method.startsWith("fs/")) return null;
    return JSON.stringify(value);
  }
  reset() {
    this.clients.clear();
    this.initializing.clear();
    for (const controller of this.active.keys()) controller.abort();
  }
  private emit(value: unknown) {
    for (const listener of this.listeners) listener(JSON.stringify(value));
  }
  async connect() {}
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async receive(
    frame: string,
    context: TransportSubmissionContext,
    signal?: AbortSignal,
    current = () => true,
  ): Promise<boolean> {
    const value = JSON.parse(frame),
      client = String(value[LOGICAL_CLIENT_FIELD] ?? "");
    if (value.method === "initialize") this.initializing.add(JSON.stringify([client, value.id]));
    if (value.method === "runtime/client/disconnect") {
      this.clients.delete(client);
      for (const [controller, owner] of this.active) if (owner === client) controller.abort();
    }
    if (typeof value.method !== "string" || !value.method.startsWith("fs/")) {
      return false;
    }
    if (value.id === undefined || value.id === null) return true;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    this.active.set(controller, client);
    try {
      if (this.closed || !this.clients.has(client)) throw Error("Client is not initialized");
      if (!HOST_FILESYSTEM_METHODS.has(value.method)) {
        this.emit({
          id: value.id,
          error: { code: -32601, message: "File operation is unsupported" },
          [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD],
        });
        return true;
      }
      this.authorize(context);
      combined.throwIfAborted();
      const result = await this.files.request(value.method, value.params, combined);
      if (!current() || this.closed || !this.clients.has(client)) return true;
      this.authorize(context);
      combined.throwIfAborted();
      this.emit({ id: value.id, result, [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD] });
    } catch {
      if (!current() || this.closed || controller.signal.aborted) return true;
      this.emit({
        id: value.id,
        error: { code: -32000, message: "File operation unavailable for this Host" },
        [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD],
      });
    } finally {
      this.active.delete(controller);
    }
    return true;
  }
  close() {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    this.clients.clear();
    this.initializing.clear();
    this.listeners.clear();
  }
}

export class HostFileSystemTransport implements DuplexTransport {
  private readonly session: HostFileSystemSession;
  private readonly removeStatus: () => void;
  constructor(
    private readonly inner: DuplexTransport,
    files: HostFileSystem,
    authorize: (context: TransportSubmissionContext) => void,
  ) {
    this.session = new HostFileSystemSession(files, authorize);
    this.removeStatus = inner.subscribeStatus((status) => {
      if (["closed", "closing", "failed"].includes(status.state)) this.session.reset();
    });
  }
  get status() {
    return this.inner.status;
  }
  connect(signal?: AbortSignal) {
    return this.inner.connect(signal);
  }
  captureMessageScope() {
    return this.inner.captureMessageScope?.() ?? (() => this.inner.status.state === "open");
  }
  subscribeStatus(listener: Parameters<DuplexTransport["subscribeStatus"]>[0]) {
    return this.inner.subscribeStatus(listener);
  }
  subscribeRecoveryHint(listener: () => void) {
    return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {});
  }
  subscribeMessage(listener: (frame: string) => void) {
    const own = this.session.subscribeMessage(listener),
      native = this.inner.subscribeMessage((frame) => {
        const projected = this.session.project(frame);
        if (projected !== null) listener(projected);
      });
    return () => {
      own();
      native();
    };
  }
  send(frame: string, signal?: AbortSignal) {
    return this.sendWithContext(frame, { sender: null }, signal);
  }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    if (await this.session.receive(frame, context, signal, this.captureMessageScope())) return;
    if (this.inner.sendWithContext) return this.inner.sendWithContext(frame, context, signal);
    return this.inner.send(frame, signal);
  }
  async close() {
    this.removeStatus();
    this.session.close();
    await this.inner.close();
  }
}
