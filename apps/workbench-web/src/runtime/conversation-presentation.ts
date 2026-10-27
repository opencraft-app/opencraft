import type { ReactNode } from "react";

/** Current conversation facts and scoped actions; no product metadata interpretation. */
export interface ConversationPresentationContext {
  readonly hostId: string;
  readonly threadId: string;
  readonly extra: unknown;
  readonly ready: boolean;
  readonly authoritative: boolean;
  readonly canFork: boolean;
  readExtra(): Promise<unknown>;
  fork(): Promise<void>;
}

export interface ConversationPresentation {
  readonly subtitle?: ReactNode;
  readonly beforeComposer?: ReactNode;
  readonly afterComposer?: ReactNode;
  /** Opt into visible, serial history reads; never Resume or reclaim execution. */
  readonly refreshHistory?: boolean;
}

/** Trusted local composition, shared by standalone and embedded roots. */
export type ConversationPresentationProvider = (context: ConversationPresentationContext) => ConversationPresentation | null;
