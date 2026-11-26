import type { DuplexTransport, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { requiresEnvironmentAuthority } from "@opencraft/execution-environment/execution-request-policy";
import {
  environmentScopeRequest,
  type EnvironmentExecutionScope,
  type EnvironmentMetadataPort,
} from "@opencraft/execution-environment/environment-metadata";

/** Browser frames never carry an ENV envelope; this composition mints none. */
const EXECUTION_ENVIRONMENT_FIELD = "__opencraftEnvironment";
const CREATION = ["thread/start", "thread/fork", "turn/start", "thread/queue/add", "thread/queue/start"];
const TRACKED = ["thread/start", "thread/fork", "thread/resume", "thread/read", "project/list", "project/create"];
const BINDS = ["thread/start", "thread/fork", "thread/resume", "thread/read"];
type Frame = Record<string, unknown>;
const object = (v: unknown): Frame => (v && typeof v === "object" && !Array.isArray(v) ? (v as Frame) : {});
const key = (v: Frame) => JSON.stringify([v[LOGICAL_CLIENT_FIELD] ?? "", v.id]);
const notSent = {
  code: -32602,
  message: "This message was not sent. Check your access and try again.",
  data: { notSubmitted: true, submissionOutcome: "rejected", retryable: false },
};
interface Pending {
  method: string;
  /** Project recorded with the Thread, or the Thread whose binding it inherits. */
  projectId: string | null;
  projectFrom?: string;
  creation?: EnvironmentExecutionScope;
}
interface Inbound {
  encoded: string;
  current: () => boolean;
  commit?: () => Promise<string>;
}

/** ENV metadata relay for an installation whose vault belongs to a separate
 * owner. Scope admission, Thread -> Project bindings, creator provenance and
 * the Project catalog are awaited on that owner's port; nothing here opens the
 * vault, holds values or signs scope. Requests are admitted and dispatched in
 * arrival order. A response is forwarded only after its metadata committed, in
 * the order the Host sent it; a failed write becomes an error response, never a
 * synchronous fallback. */
export class EnvironmentMetadataTransport implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly inbound: Inbound[] = [];
  private readonly unsubscribeInner: () => void;
  private outbound: Promise<unknown> = Promise.resolve();
  private draining: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly inner: DuplexTransport,
    private readonly metadata: EnvironmentMetadataPort,
    private readonly hostId: string,
  ) {
    this.unsubscribeInner = this.inner.subscribeMessage((frame) => this.receive(frame));
  }
  get status() {
    return this.inner.status;
  }
  connect(signal?: AbortSignal) {
    return this.inner.connect(signal);
  }
  /** Stops new requests, lets admitted requests reach the Host and drains the
   * responses whose metadata is still committing before the Host closes. */
  close() {
    return (this.closing ??= (async () => {
      await this.outbound.catch(() => {});
      this.unsubscribeInner();
      await this.draining;
      this.pending.clear();
      this.listeners.clear();
      await this.inner.close();
    })());
  }
  subscribeStatus(listener: Parameters<DuplexTransport["subscribeStatus"]>[0]) {
    return this.inner.subscribeStatus(listener);
  }
  captureMessageScope() {
    return this.inner.captureMessageScope?.() ?? (() => this.inner.status.state === "open");
  }
  subscribeRecoveryHint(listener: () => void) {
    return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {});
  }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(frame: string) {
    for (const listener of this.listeners) listener(frame);
  }
  private receive(frame: string) {
    let value: Frame;
    try {
      value = object(JSON.parse(frame));
    } catch {
      return this.deliver({ encoded: frame, current: () => true });
    }
    const pending = value.method ? undefined : this.pending.get(key(value));
    if (pending) this.pending.delete(key(value));
    delete value[EXECUTION_ENVIRONMENT_FIELD];
    const encoded = JSON.stringify(value);
    const commit = pending && !value.error ? this.commit(pending, value, encoded) : undefined;
    // Delivery after an await must still belong to the native owner that sent it.
    this.deliver({ encoded, current: this.captureMessageScope(), ...(commit ? { commit } : {}) });
  }
  private commit(pending: Pending, value: Frame, encoded: string): (() => Promise<string>) | undefined {
    const result = object(value.result),
      thread = object(result.thread);
    const threadId = typeof thread.id === "string" ? thread.id : undefined;
    const creation = pending.creation && threadId ? pending.creation : undefined;
    const binds = BINDS.includes(pending.method) && threadId !== undefined;
    const projects =
      pending.method === "project/list" && Array.isArray(result.data)
        ? result.data
        : pending.method === "project/create" && result.project
          ? [result.project]
          : undefined;
    if (!creation && !binds && !projects) return undefined;
    const rejected = (message: string) =>
      JSON.stringify({ ...value, result: undefined, error: { code: -32000, message } });
    return async () => {
      if (creation) {
        try {
          await this.metadata.bindCreator(creation, threadId!);
        } catch {
          return rejected("Unable to bind task credentials");
        }
      }
      try {
        if (binds) {
          const projectId =
            typeof thread.projectId === "string"
              ? thread.projectId
              : pending.projectFrom === undefined
                ? pending.projectId
                : await this.metadata.project(this.hostId, pending.projectFrom);
          await this.metadata.bind(this.hostId, threadId!, projectId);
        }
        if (projects)
          await this.metadata.rememberProjects(
            this.hostId,
            // Host data; the vault owner validates each entry before writing.
            projects.map((p: unknown) => ({ id: object(p).id, name: object(p).name }) as { id: string; name: string }),
          );
      } catch {
        return rejected("Unable to record the task environment");
      }
      return encoded;
    };
  }
  /** Frames leave in arrival order. With nothing committing, a frame is still
   * delivered inside the Host's own callback. */
  private deliver(item: Inbound) {
    if (!this.inbound.length && !item.commit) return this.emit(item.encoded);
    this.inbound.push(item);
    this.draining ??= (async () => {
      while (this.inbound.length) {
        const next = this.inbound[0]!;
        const frame = next.commit ? await next.commit() : next.encoded;
        this.inbound.shift();
        try {
          if (next.current()) this.emit(frame);
        } catch {
          // An observer failure must not stall the frames behind it.
        }
      }
      this.draining = undefined;
    })();
  }
  send(frame: string, signal?: AbortSignal) {
    return this.sendWithContext(frame, { sender: null }, signal);
  }
  private rejectBeforeDelivery(value: Frame, error: unknown) {
    // Only failures before inner.send are known not to have been submitted.
    if (value.id === undefined) throw error;
    this.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: value.id,
        [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD],
        error: notSent,
      }),
    );
  }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    if (this.closing) throw new Error("Host transport closed");
    const value = object(JSON.parse(frame)),
      params = object(value.params);
    delete value[EXECUTION_ENVIRONMENT_FIELD];
    delete params[EXECUTION_ENVIRONMENT_FIELD];
    // Admission awaits the vault owner; dispatch keeps arrival order.
    const step = this.outbound.then(() => this.dispatch(value, params, context, signal));
    this.outbound = step.catch(() => {});
    const dispatched = await step;
    if (!dispatched) return;
    try {
      await dispatched.delivery;
    } catch (error) {
      this.pending.delete(key(value));
      throw error;
    }
  }
  private async dispatch(
    value: Frame,
    params: Frame,
    context: TransportSubmissionContext,
    signal?: AbortSignal,
  ): Promise<{ delivery: Promise<void> } | undefined> {
    const method = typeof value.method === "string" ? value.method : undefined;
    // Collaboration queue admission is authorized from the durable request
    // ledger by the Host. It must not borrow the creator's credentials.
    const collaborationQueueAdmission =
      method === "thread/queue/add" &&
      typeof context.collaborationRequestId === "string" &&
      params.clientUserMessageId === `actor-input:${context.collaborationRequestId}`;
    let admitted: EnvironmentExecutionScope | undefined;
    try {
      if (method && requiresEnvironmentAuthority(method, context.collaborationRequestId) && !collaborationQueueAdmission) {
        admitted = await this.metadata.admit(environmentScopeRequest(context, this.hostId, params));
        // The submission may have lost authority while the owner answered.
        environmentScopeRequest(context, this.hostId, params);
      }
    } catch {
      if (value.id !== undefined)
        this.emit(
          JSON.stringify({
            ...(value.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
            id: value.id,
            ...(value[LOGICAL_CLIENT_FIELD] === undefined
              ? {}
              : { [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD] }),
            error: notSent,
          }),
        );
      return undefined;
    }
    try {
      let scope: EnvironmentExecutionScope | undefined;
      if (method && CREATION.includes(method) && !collaborationQueueAdmission) {
        // Fork creates an independent task for its authenticated creator. Never
        // inherit the source task's credential identity.
        if (method === "thread/fork") {
          const projectId =
            typeof params.threadId === "string" ? await this.metadata.project(this.hostId, params.threadId) : null;
          scope = await this.metadata.admit(environmentScopeRequest(context, this.hostId, { projectId }));
        } else scope = admitted ?? (await this.metadata.admit(environmentScopeRequest(context, this.hostId, params)));
        environmentScopeRequest(context, this.hostId, params);
      }
      if (value.id !== undefined && method && TRACKED.includes(method)) {
        if (this.pending.size >= 512) throw new Error("Environment request limit reached");
        const explicit = typeof params.projectId === "string" ? params.projectId : undefined;
        const inherited =
          scope || explicit !== undefined || typeof params.threadId !== "string" ? undefined : params.threadId;
        this.pending.set(key(value), {
          method,
          projectId: scope?.projectId ?? explicit ?? null,
          ...(inherited === undefined ? {} : { projectFrom: inherited }),
          ...(["thread/start", "thread/fork"].includes(method) && scope ? { creation: scope } : {}),
        });
      }
    } catch (error) {
      this.pending.delete(key(value));
      this.rejectBeforeDelivery(value, error);
      return undefined;
    }
    const encoded = JSON.stringify(value);
    const delivery = this.inner.sendWithContext
      ? this.inner.sendWithContext(encoded, context, signal)
      : this.inner.send(encoded, signal);
    return { delivery };
  }
}
