import type { DuplexTransport, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { OPENCRAFT_METHOD_ACCESS_EXTENSION } from "@opencraft/appserver-protocol";
import { HOST_FILESYSTEM_METHODS, type HostFileSystem } from "./host-filesystem.js";

/** Trusted owner selection; raw path/thread hints are never authorization. The
 * selector must resolve through current principal/resource grants and must throw
 * for a missing remote binding instead of returning local files. */
export type HostFileService = Pick<HostFileSystem, "request">;
export interface HostFileBinding {
  files: HostFileService;
  /** Rechecks that the same lease and authority still own this request. */
  assertCurrent(): void | Promise<void>;
}
export type HostFileSelector = (context: TransportSubmissionContext, params: unknown) => Promise<HostFileBinding>;

// The composition receives the actual local port with the same request authority,
// not an invented controller filesystem. Remote failures are never caught here.
export function composeHostFileSelector(
  files: HostFileService,
  authorize: (context: TransportSubmissionContext) => void,
  select:
    | ((context: TransportSubmissionContext, params: unknown, local: HostFileSelector) => Promise<HostFileBinding>)
    | undefined,
): HostFileSelector | undefined {
  if (!select) return undefined;
  const local: HostFileSelector = async (context, params) => {
    if (params && typeof params === "object" && Object.hasOwn(params, "workspaceThreadId"))
      throw Error("Workspace files cannot use the local binding");
    const assertCurrent = () => authorize(context);
    assertCurrent();
    return { files, assertCurrent };
  };
  return (context, params) => select(context, params, local);
}

/** Selected Host files never fall through to an engine's controller filesystem. */
export class HostFileSystemSession {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly initializing = new Set<string>();
  private readonly clients = new Set<string>();
  private readonly active = new Map<AbortController, string>();
  private closed = false;
  constructor(
    private readonly files: HostFileService,
    private readonly authorize: (context: TransportSubmissionContext) => void,
    private readonly selectFiles?: HostFileSelector,
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
      // This is a routing hint, not identity. It never reaches a filesystem
      // implementation; a configured trusted selector must resolve its authority.
      const scoped =
        value.params && typeof value.params === "object" && Object.hasOwn(value.params, "workspaceThreadId");
      if (
        scoped &&
        (!this.selectFiles ||
          typeof value.params.workspaceThreadId !== "string" ||
          !value.params.workspaceThreadId ||
          value.params.workspaceThreadId.length > 512 ||
          /[\x00-\x1f\x7f]/u.test(value.params.workspaceThreadId))
      )
        throw Error("Invalid workspace file scope");
      const selectedParams = scoped ? Object.freeze({ ...value.params }) : value.params;
      const binding = this.selectFiles ? await this.selectFiles(context, selectedParams) : undefined;
      const requestParams = scoped
        ? Object.fromEntries(Object.entries(value.params).filter(([key]) => key !== "workspaceThreadId"))
        : value.params;
      if (this.selectFiles && !binding) throw Error("File binding unavailable");
      if (binding) await binding.assertCurrent();
      this.authorize(context);
      combined.throwIfAborted();
      const result = await (binding ? binding.files : this.files).request(value.method, requestParams, combined);
      if (binding) await binding.assertCurrent();
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
    files: HostFileService,
    authorize: (context: TransportSubmissionContext) => void,
    selectFiles?: HostFileSelector,
  ) {
    this.session = new HostFileSystemSession(files, authorize, selectFiles);
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
