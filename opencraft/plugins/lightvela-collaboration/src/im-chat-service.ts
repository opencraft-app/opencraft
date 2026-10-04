import {
  MessagingSendError,
  type ConversationAddress,
  type Message,
  type MessagePage,
  type ReconcileMessageInput,
  type ReconcileMessageResult,
  type SendTextInput,
} from "@lightvela/vela-chat-client-core";

export interface ImChatMessagingPort {
  loadHistory(address: ConversationAddress, cursor?: string): Promise<MessagePage>;
  markRead(address: ConversationAddress): Promise<void>;
  reconcileMessage(input: ReconcileMessageInput): Promise<ReconcileMessageResult>;
  sendText(input: SendTextInput): Promise<Message>;
  subscribeMessages(listener: (messages: Message[]) => void): () => void;
  waitUntilReady(timeoutMs: number): Promise<void>;
}

export interface ImChatSnapshot {
  readonly phase: "idle" | "loading" | "ready" | "sending" | "error";
  readonly address: ConversationAddress | null;
  readonly messages: readonly Message[];
  readonly draft: string;
  readonly historyCompleted: boolean;
  readonly historyCursor: string | null;
  readonly historyLoading: boolean;
  readonly sendResolution: "none" | "uncertain";
  readonly error: string | null;
  readonly revision: number;
}

export interface ImChatServiceOptions {
  readonly createRequestId?: () => string;
}

function mergeMessages(current: readonly Message[], incoming: readonly Message[]): readonly Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Object.freeze([...byId.values()].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  ));
}

export class ImChatService {
  private readonly listeners = new Set<() => void>();
  private readonly createRequestId: () => string;
  private readonly unsubscribeMessages: () => void;
  private readonly drafts = new Map<string, string>();
  private readonly pendingSends = new Map<string, { readonly requestId: string; readonly draft: string }>();
  private historyOperation: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private snapshot: ImChatSnapshot = Object.freeze({
    phase: "idle",
    address: null,
    messages: Object.freeze([]),
    draft: "",
    historyCompleted: true,
    historyCursor: null,
    historyLoading: false,
    sendResolution: "none",
    error: null,
    revision: 0,
  });

  constructor(
    private readonly messaging: ImChatMessagingPort,
    options: ImChatServiceOptions = {},
  ) {
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.unsubscribeMessages = messaging.subscribeMessages((messages) => {
      const address = this.snapshot.address;
      if (this.disposed || address === null) return;
      const visible = messages.filter(
        (message) => message.conversationId === address.conversationId,
      );
      if (visible.length === 0) return;
      this.publish({ messages: mergeMessages(this.snapshot.messages, visible) });
    });
  }

  getSnapshot = (): ImChatSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(address: ConversationAddress): Promise<void> {
    if (this.disposed) throw new Error("IM Chat service is disposed");
    const generation = ++this.generation;
    this.historyOperation = null;
    this.publish({
      phase: "loading",
      address,
      messages: Object.freeze([]),
      draft: this.drafts.get(address.conversationId) ?? "",
      historyCompleted: false,
      historyCursor: null,
      historyLoading: false,
      sendResolution: this.pendingSends.has(address.conversationId) ? "uncertain" : "none",
      error: null,
    });
    try {
      await this.messaging.waitUntilReady(15_000);
      const page = await this.messaging.loadHistory(address);
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        phase: "ready",
        messages: mergeMessages(page.messages, this.snapshot.messages),
        historyCompleted: page.completed,
        historyCursor: page.nextCursor ?? null,
        error: null,
      });
      try {
        await this.messaging.markRead(address);
      } catch (error) {
        if (!this.disposed && generation === this.generation) {
          this.publish({
            error: `消息已加载，但已读同步失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  loadOlder(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("IM Chat service is disposed"));
    const { address, historyCompleted, historyCursor } = this.snapshot;
    if (address === null || historyCompleted || historyCursor === null) return Promise.resolve();
    if (this.historyOperation !== null) return this.historyOperation;
    const generation = this.generation;
    this.publish({ historyLoading: true, error: null });
    const operation = this.messaging.loadHistory(address, historyCursor).then((page) => {
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        messages: mergeMessages(this.snapshot.messages, page.messages),
        historyCompleted: page.completed,
        historyCursor: page.nextCursor ?? null,
        error: null,
      });
    }).catch((error: unknown) => {
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (this.historyOperation === operation) this.historyOperation = null;
      if (!this.disposed && generation === this.generation) {
        this.publish({ historyLoading: false });
      }
    });
    this.historyOperation = operation;
    return operation;
  }

  setDraft(draft: string): void {
    if (this.disposed) return;
    const conversationId = this.snapshot.address?.conversationId;
    if (conversationId !== undefined) this.drafts.set(conversationId, draft);
    this.publish({ draft });
  }

  async sendDraft(): Promise<void> {
    const address = this.snapshot.address;
    if (this.disposed || address === null || this.snapshot.phase === "sending") return;
    const pending = this.pendingSends.get(address.conversationId);
    if (pending !== undefined) {
      this.publish({ phase: "sending", error: null });
      try {
        const result = await this.messaging.reconcileMessage({
          channel: address,
          clientRequestId: pending.requestId,
        });
        if (result.state === "sent") {
          this.completeSend(address, pending.draft, result.message);
        } else if (result.state === "failed") {
          this.pendingSends.delete(address.conversationId);
          if (!this.disposed && this.snapshot.address?.conversationId === address.conversationId) {
            this.publish({ phase: "error", sendResolution: "none", error: result.error });
          }
        } else if (!this.disposed && this.snapshot.address?.conversationId === address.conversationId) {
          this.publish({ phase: "error", sendResolution: "uncertain", error: "发送结果尚未确认" });
        }
      } catch (error) {
        if (!this.disposed && this.snapshot.address?.conversationId === address.conversationId) {
          this.publish({
            phase: "error",
            sendResolution: "uncertain",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return;
    }
    const draft = this.snapshot.draft;
    const text = draft.trim();
    if (text === "") return;
    const requestId = this.createRequestId();
    this.publish({ phase: "sending", error: null });
    try {
      const message = await this.messaging.sendText({
        channel: address,
        clientRequestId: requestId,
        mentions: [],
        text,
      });
      this.completeSend(address, draft, message);
    } catch (error) {
      if (error instanceof MessagingSendError && error.outcome === "uncertain") {
        this.pendingSends.set(address.conversationId, { requestId, draft });
      }
      if (this.disposed || this.snapshot.address?.conversationId !== address.conversationId) return;
      this.publish({
        phase: "error",
        sendResolution: this.pendingSends.has(address.conversationId) ? "uncertain" : "none",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private completeSend(address: ConversationAddress, draft: string, message: Message): void {
    this.pendingSends.delete(address.conversationId);
    if (this.drafts.get(address.conversationId) === draft) {
      this.drafts.delete(address.conversationId);
    }
    if (this.disposed || this.snapshot.address?.conversationId !== address.conversationId) return;
    this.publish({
      phase: "ready",
      draft: this.drafts.get(address.conversationId) ?? "",
      messages: mergeMessages(this.snapshot.messages, [message]),
      sendResolution: "none",
      error: null,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.unsubscribeMessages();
    this.listeners.clear();
  }

  private publish(patch: Partial<Omit<ImChatSnapshot, "revision">>): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    });
    this.listeners.forEach((listener) => listener());
  }
}
