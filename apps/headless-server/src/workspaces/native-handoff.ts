import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { WorkspaceExecutionSelection } from "@opencraft/sandbox-node/workspace-execution-channel";
import type { CodexNativeRequestAdmission } from "@opencraft/opencraft-daemon/codex-engine-adapter";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import type { WorkspaceExecutionPort, WorkspacePreparation } from "./execution-owner.js";

type Receipt = { workspaceId: string; threadId: string };
type Prepared =
  { kind: "existing"; receipt: Receipt } | { kind: "dispatch"; resolve(): Promise<WorkspaceExecutionSelection> };
interface Attempt {
  context: TransportSubmissionContext;
  admission: WorkspaceActorAdmission;
  request: CodexNativeRequestAdmission;
  token: Promise<string>;
  active: boolean;
  returned: boolean;
  receipted: boolean;
}

/** One per physical Native attachment. Correlation/tombstones are bounded and
 * ephemeral; the Worker remains the sole durable placement and provider owner.
 * In particular, abort cannot erase a possible late positive Native receipt. */
export class WorkspaceNativeHandoff {
  private readonly attempts = new Map<string, Attempt>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      port: WorkspaceExecutionPort;
      admit(context: TransportSubmissionContext): WorkspaceActorAdmission;
      /** Refresh committed placement, including positive-but-unpublished evidence. */
      placementChanged(): Promise<void>;
    },
  ) {}
  private key(id: string | number): string {
    return JSON.stringify([typeof id, id]);
  }
  private current(attempt: Attempt) {
    if (this.closed || !attempt.active || attempt.request.context() !== attempt.context)
      throw Error("Workspace Native request unavailable");
  }
  async prepare(
    id: string | number,
    request: CodexNativeRequestAdmission,
    preparation: WorkspacePreparation,
  ): Promise<Prepared> {
    const key = this.key(id);
    if (
      this.closed ||
      this.attempts.has(key) ||
      this.attempts.size >= 64 ||
      request.method !== (preparation.kind === "start" ? "thread/start" : preparation.kind === "fork" ? "thread/fork" : "thread/resume")
    )
      throw Error("Workspace Native request unavailable");
    const context = request.context(),
      admission = this.options.admit(context);
    const attempt: Attempt = {
      context,
      admission,
      request,
      token: this.options.port.workspaceBegin(admission, preparation),
      active: true,
      returned: false,
      receipted: false,
    };
    this.attempts.set(key, attempt);
    try {
      const token = await attempt.token;
      for (;;) {
        this.current(attempt);
        const status = await this.options.port.workspaceStatus(token);
        this.current(attempt);
        if (status.state === "failed") throw Error("Workspace preparation failed");
        if (status.state === "complete") {
          if (preparation.kind === "restore") throw Error("Native resume receipt missing");
          await this.options.placementChanged();
          await this.options.port.workspaceForget(token);
          this.attempts.delete(key);
          return { kind: "existing", receipt: status.receipt };
        }
        if (status.state === "native-ready") {
          attempt.returned = true;
          return {
            kind: "dispatch",
            resolve: async () => {
              this.current(attempt);
              const latest = await this.options.port.workspaceStatus(token);
              this.current(attempt);
              if (
                latest.state !== "native-ready" ||
                JSON.stringify(latest.selection) !== JSON.stringify(status.selection)
              )
                throw Error("Workspace Native selection changed");
              return latest.selection;
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (cause) {
      // No resolver escaped, so this invocation cannot have reached Native.
      // Only this local proof allows a negative receipt; send failure after
      // prepare returned is UNKNOWN and must retain its positive-reply slot.
      if (!attempt.returned) {
        try {
          const token = await attempt.token;
          Atomics.store(admission.requestPermit, 0, 0);
          await this.options.port.workspaceCancel(token);
          try {
            await this.options.port.workspaceNativeReceipt(token, { error: true });
          } catch {
            /* Domain may already have failed. */
          }
          await this.options.port.workspaceForget(token);
          this.attempts.delete(key);
        } catch {
          /* Keep unresolved correlation bounded and fail closed. */
        }
      }
      throw cause;
    }
  }
  async finalize(input: {
    requestId: string | number;
    context: TransportSubmissionContext;
    result?: unknown;
    error?: unknown;
  }) {
    const key = this.key(input.requestId),
      attempt = this.attempts.get(key);
    if (!attempt || attempt.receipted || !attempt.returned || attempt.context !== input.context)
      throw Error("Workspace Native receipt unavailable");
    // Do not ask context() again: expiration cannot erase a physical receipt.
    // Worker records identity first and rechecks its own authority to publish.
    const token = await attempt.token;
    try {
      const receipt = await this.options.port.workspaceNativeReceipt(
        token,
        Object.hasOwn(input, "error") ? { error: true } : { result: input.result },
      );
      attempt.receipted = true;
      return receipt;
    } finally {
      // Failure may mean durable positive evidence plus denied publication.
      // Never classify that Thread as local or discard its Worker tombstone.
      await this.options.placementChanged();
      try {
        await this.options.port.workspaceForget(token);
        this.attempts.delete(key);
      } catch {
        /* Invalid/missing receipts cannot consume the valid late reply. */
      }
    }
  }
  /** Receipt correlation only, never a durable placement or delivery claim. */
  retainsReceipt(id: string | number): boolean {
    return this.attempts.has(this.key(id));
  }
  async abort(id: string | number) {
    const attempt = this.attempts.get(this.key(id));
    if (!attempt) return;
    attempt.active = false;
    Atomics.store(attempt.admission.requestPermit, 0, 0);
    await this.options.port.workspaceCancel(await attempt.token);
    // Do not forget, retire the resource permit, or synthesize non-delivery.
  }
  async interrupt() {
    const results = await Promise.allSettled(
      [...this.attempts.keys()].map((key) => {
        const [, id] = JSON.parse(key) as [string, string | number];
        return this.abort(id);
      }),
    );
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Workspace Native cancellation unconfirmed");
  }
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.interrupt();
    })());
  }
}
