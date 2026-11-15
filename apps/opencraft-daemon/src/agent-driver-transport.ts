import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { COLLABORATION_METHOD, COLLABORATION_CAPABILITIES } from "@opencraft/appserver-protocol/collaboration";
import { randomUUID } from "node:crypto";
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { Collaboration } from "../../../packages/access-control/src/collaboration.js";

/** Establish execution authority at authenticated ingress. Internal Host control
 * methods cannot be promoted from a Renderer frame into trusted admission. */
export class AgentDriverTransport implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly initializing = new Set<string>();
  private readonly unsubscribe: () => void;
  private key(message: Record<string, unknown>) { return JSON.stringify([message[LOGICAL_CLIENT_FIELD] ?? "", message.id]); }
  private emit(frame: string) { for (const listener of this.listeners) listener(frame); }
  constructor(private readonly inner: DuplexTransport, private readonly collaboration: Collaboration,
    private readonly serverForThread: (threadId: string) => string,
    private readonly signCli?: (session: import("@opencraft/session-capabilities").CapabilitySession) => string) {
    this.unsubscribe = inner.subscribeMessage(raw => {
      const message = JSON.parse(raw);
      if (this.initializing.delete(this.key(message)) && message.result) {
        const capabilities = message.result.capabilities ??= {}, extensions = capabilities.extensions ??= {};
        extensions[COLLABORATION_METHOD] = COLLABORATION_CAPABILITIES;
        const access = extensions["opencraft/method-access"];
        if (Array.isArray(access?.methods)) access.methods = [...new Set([...access.methods, COLLABORATION_METHOD])];
        raw = JSON.stringify(message);
      }
      this.emit(raw);
    });
  }
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  subscribeMessage(listener: (frame: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void) { return this.inner.subscribeStatus(listener); }
  close() { this.unsubscribe(); this.listeners.clear(); this.initializing.clear(); return this.inner.close(); }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    const message = JSON.parse(frame), params = message.params ?? {};
    if (message.method === "initialize") this.initializing.add(this.key(message));
    if (message.method === COLLABORATION_METHOD) {
      const envelope = {id:message.id,...(message[LOGICAL_CLIENT_FIELD] === undefined ? {} : {[LOGICAL_CLIENT_FIELD]:message[LOGICAL_CLIENT_FIELD]})};
      try {
        if (!context.actorContext) throw Object.assign(new Error("actor_authentication_required"), {code:"actor_authentication_required",status:401});
        context.resourceOwner?.assertCurrent();
        const result = await this.collaboration.command(context.actorContext, params);
        context.resourceOwner?.assertCurrent();
        this.emit(JSON.stringify({...envelope,result}));
      } catch (error) {
        const fault = error as {code?:unknown;status?:unknown};
        this.emit(JSON.stringify({...envelope,error:{code:-32070,message:"Conversation operation unavailable",data:{code:fault.code,status:fault.status}}}));
      }
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("opencraft/orchestration/")) {
      if (!context.orchestrationOperationId || context.orchestrationOperationId !== params.operationId || !context.orchestrationCanAdmit?.())
        throw new Error("Trusted orchestration admission required");
    }
    // Renderer fields never confer execution identity, including on anonymous input.
    delete params.__opencraftExecutionCli;
    if (context.actorContext && ["turn/start", "thread/queue/add", "turn/steer"].includes(message.method)) {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || !threadId) throw new Error("Execution Thread required");
      const inputId = params.clientUserMessageId ?? `human-input:${randomUUID()}`;
      if (typeof inputId !== "string" || !inputId || inputId.length > 512) throw new Error("Invalid execution input identity");
      this.collaboration.authorizeExecution(context.actorContext, threadId, inputId, params.input ?? [], this.serverForThread(threadId));
      message.params = { ...params, clientUserMessageId: inputId,
        ...(this.signCli && ["turn/start", "thread/queue/add"].includes(message.method) ? {__opencraftExecutionCli:this.signCli({serverId:this.serverForThread(threadId),threadId,execution:{inputId,executionId:randomUUID()}})} : {}) };
    }
    // The remote Host receives data, while authority remains in the gateway.
    if (this.inner.sendWithContext) await this.inner.sendWithContext(JSON.stringify(message), context, signal);
    else await this.inner.send(JSON.stringify(message), signal);
  }
}
