import { Service, type Context } from "@deepseek-ai/cordis";
import type { AuthenticationFlow, AuthenticationFlowPort, AuthenticationFlowRequest, AuthenticationFlowResult } from "./contract";

declare module "@deepseek-ai/cordis" {
  interface Context { authenticationFlows: AuthenticationFlowService }
}

/** Coordinates one interactive login. No React, routes, tokens, profile data or business mutations. */
export class AuthenticationFlowService extends Service implements AuthenticationFlowPort {
  static inject = ["authentication"];
  private snapshot: AuthenticationFlow | null = null;
  private readonly listeners = new Set<() => void>();
  private operation: { id: string; providerId: string; promise: Promise<AuthenticationFlowResult> } | null = null;
  private disposed = false;

  constructor(ctx: Context) {
    super(ctx, "authenticationFlows");
    ctx.effect(() => ctx.authentication.subscribe(() => {
      const flow = this.snapshot;
      if (flow && ctx.authentication.getSession(flow.providerId) === null) this.publish(null);
    }));
    ctx.effect(() => () => {
      this.disposed = true;
      if (this.snapshot) this.cancel(this.snapshot.id);
      this.listeners.clear();
    });
  }

  getSnapshot = (): AuthenticationFlow | null => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  open(request: AuthenticationFlowRequest): string {
    if (this.disposed) throw new Error("Authentication flow service is disposed");
    if (!this.ctx.authentication.getSession(request.providerId)) throw new Error("Authentication provider unavailable");
    const previous = this.snapshot;
    if (previous?.owner === request.owner && previous.providerId === request.providerId && previous.optionId === request.optionId) return previous.id;
    if (previous) this.cancel(previous.id);
    else if (this.operation) void this.ctx.authentication.cancel(this.operation.providerId).catch(() => undefined);
    const id = crypto.randomUUID();
    this.publish(Object.freeze({ ...request, id, phase: "ready", error: null }));
    return id;
  }

  submit(id: string): Promise<AuthenticationFlowResult> {
    if (this.snapshot?.id !== id) return Promise.resolve({ status: "abandoned" });
    if (this.operation?.id === id) return this.operation.promise;
    const flow = this.snapshot;
    this.publish(Object.freeze({ ...flow, phase: "pending", error: null }));
    const promise = this.ctx.authentication.signIn(flow.providerId, flow.optionId).then((result): AuthenticationFlowResult => {
      if (this.snapshot?.id !== id) return { status: "abandoned" };
      if (result.status !== "redirecting") this.publish(null);
      return result;
    }).catch((): AuthenticationFlowResult => {
      if (this.snapshot?.id !== id) return { status: "abandoned" };
      // Transport details can contain callback URLs. Expose only a safe UI error.
      this.publish(Object.freeze({ ...flow, phase: "error", error: "登录未完成，请重试。" }));
      return { status: "error" };
    }).finally(() => { if (this.operation?.id === id) this.operation = null; });
    this.operation = { id, providerId: flow.providerId, promise };
    return promise;
  }

  cancel(id: string): void {
    const flow = this.snapshot;
    if (flow?.id !== id) return;
    this.publish(null);
    if (flow.phase === "pending") void this.ctx.authentication.cancel(flow.providerId).catch(() => undefined);
  }

  /** Leaving a feature revokes only its UI continuation. A valid browser callback may still install a session. */
  abandon(id: string): void {
    if (this.snapshot?.id === id) this.publish(null);
  }

  private publish(snapshot: AuthenticationFlow | null): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
