import type {
  ConversationAddress,
  Message,
  MessagePage,
  SendTextInput,
} from "@lightvela/vela-chat-client-core";

export interface ImChatMessagingPort {
  loadHistory(address: ConversationAddress, cursor?: string): Promise<MessagePage>;
  markRead(address: ConversationAddress): Promise<void>;
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
  readonly error: string | null;
  readonly revision: number;
}

export interface ImChatServiceOptions {
  readonly createRequestId?: () => string;
}

function mergeMessages(current: readonly Message[], incoming: readonly Message[]): readonly Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Object.freeze([...byId.values()]);
}

export class ImChatService {
  private readonly listeners = new Set<() => void>();
  private readonly createRequestId: () => string;
  private readonly unsubscribeMessages: () => void;
  private generation = 0;
  private disposed = false;
  private snapshot: ImChatSnapshot = Object.freeze({
    phase: "idle",
    address: null,
    messages: Object.freeze([]),
    draft: "",
    historyCompleted: true,
    historyCursor: null,
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
    this.publish({
      phase: "loading",
      address,
      messages: Object.freeze([]),
      historyCompleted: false,
      historyCursor: null,
      error: null,
    });
    try {
      await this.messaging.waitUntilReady(15_000);
      const page = await this.messaging.loadHistory(address);
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        phase: "ready",
        messages: mergeMessages([], page.messages),
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

  setDraft(draft: string): void {
    if (this.disposed) return;
    this.publish({ draft });
  }

  async sendDraft(): Promise<void> {
    const address = this.snapshot.address;
    const text = this.snapshot.draft.trim();
    if (this.disposed || address === null || text === "" || this.snapshot.phase === "sending") return;
    this.publish({ phase: "sending", error: null });
    try {
      const message = await this.messaging.sendText({
        channel: address,
        clientRequestId: this.createRequestId(),
        mentions: [],
        text,
      });
      if (this.disposed || this.snapshot.address?.conversationId !== address.conversationId) return;
      this.publish({
        phase: "ready",
        draft: "",
        messages: mergeMessages(this.snapshot.messages, [message]),
      });
    } catch (error) {
      if (this.disposed || this.snapshot.address?.conversationId !== address.conversationId) return;
      this.publish({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
