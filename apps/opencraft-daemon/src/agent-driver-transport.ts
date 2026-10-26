import { randomUUID } from "node:crypto";
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { Collaboration } from "../../../packages/access-control/src/collaboration.js";

/** Establish execution authority at authenticated ingress. Internal Host control
 * methods cannot be promoted from a Renderer frame into trusted admission. */
export class AgentDriverTransport implements DuplexTransport {
  constructor(private readonly inner: DuplexTransport, private readonly collaboration: Collaboration,
    private readonly serverForThread: (threadId: string) => string) {}
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  subscribeMessage(listener: (frame: string) => void) { return this.inner.subscribeMessage(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void) { return this.inner.subscribeStatus(listener); }
  close() { return this.inner.close(); }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    const message = JSON.parse(frame), params = message.params ?? {};
    if (typeof message.method === "string" && message.method.startsWith("opencraft/orchestration/")) {
      if (!context.orchestrationOperationId || context.orchestrationOperationId !== params.operationId || !context.orchestrationCanAdmit?.())
        throw new Error("Trusted orchestration admission required");
    }
    if (context.actorContext && ["turn/start", "thread/queue/add", "turn/steer"].includes(message.method)) {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || !threadId) throw new Error("Execution Thread required");
      const inputId = params.clientUserMessageId ?? `human-input:${randomUUID()}`;
      if (typeof inputId !== "string" || !inputId || inputId.length > 512) throw new Error("Invalid execution input identity");
      this.collaboration.authorizeExecution(context.actorContext, threadId, inputId, params.input ?? [], this.serverForThread(threadId));
      message.params = { ...params, clientUserMessageId: inputId };
    }
    // The remote Host receives data, while authority remains in the gateway.
    await this.inner.send(JSON.stringify(message), signal);
  }
}
