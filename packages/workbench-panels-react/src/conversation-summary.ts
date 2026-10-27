import { Service, type Context } from "@deepseek-ai/cordis";
import type { TimelineSnapshot } from "@opencraft/chat-core";
import type { ComponentType } from "react";

/** Trusted renderer port. The conversation remains the sole data owner. */
export interface ConversationSummaryContext {
  readonly scopeKey: string;
  readonly title?: string;
  readonly timeline: TimelineSnapshot | null;
  readonly goal: { readonly objective: string; readonly status: string } | null;
  readonly current: boolean;
  readonly onOpenResource: (path: string) => void;
  readonly onOpenThread: (threadId: string) => void;
}

/** View state survives a change of presentation without persisting business data. */
export interface ConversationSummaryViewState {
  readonly collapsed: ReadonlySet<string>;
  readonly scrollTop: number;
}

export interface ConversationSummaryProps {
  readonly context: ConversationSummaryContext;
  readonly viewState: ConversationSummaryViewState;
  readonly onViewStateChange: (state: ConversationSummaryViewState) => void;
}

export interface ConversationSummaryContribution {
  readonly id: string;
  readonly title: { readonly id: string; readonly defaultMessage: string };
  readonly Component: ComponentType<ConversationSummaryProps>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { conversationSummary: ConversationSummaryService }
}

/** One optional summary, registered and revoked with its trusted plugin fiber. */
export class ConversationSummaryService extends Service {
  private registration: { readonly value: ConversationSummaryContribution } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context) {
    super(ctx, "conversationSummary");
    ctx.effect(() => () => { this.registration = null; this.publish(); });
  }

  register(value: ConversationSummaryContribution): () => void {
    if (!value.id.trim()) throw new TypeError("Conversation summary id is required");
    if (this.registration) throw new Error("Conversation summary already has an owner");
    const registration = { value };
    this.registration = registration;
    this.publish();
    return () => {
      if (this.registration !== registration) return;
      this.registration = null;
      this.publish();
    };
  }

  getSnapshot = (): ConversationSummaryContribution | null => this.registration?.value ?? null;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() { for (const listener of this.listeners) listener(); }
}
