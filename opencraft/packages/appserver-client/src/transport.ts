import type { MessageSender } from "@opencraft/appserver-protocol";

/** Trusted in-process context. Never decoded from a Renderer frame. */
export interface TransportSubmissionContext {
  readonly sender: MessageSender | null;
  readonly validUntil?: number;
}

export type TransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "failed";

/**
 * The transport owns failure classification because only it understands the
 * remote resource and physical link. Runtime owners consume this disposition
 * when deciding whether an automatic reconnect is meaningful.
 */
export interface TransportFailureDisposition {
  readonly code: string;
  readonly recovery: "automatic" | "manual";
}

export interface TransportStatus {
  state: TransportState;
  reason?: string;
  /** Omitted by legacy transports, which remain automatically recoverable. */
  failure?: TransportFailureDisposition;
}

export interface DuplexTransport {
  readonly status: TransportStatus;
  connect(signal?: AbortSignal): Promise<void>;
  /** Signal ends local request work, not an already-admitted remote Turn. */
  send(frame: string, signal?: AbortSignal): Promise<void>;
  sendWithContext?(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void>;
  subscribeMessage(listener: (frame: string) => void): () => void;
  subscribeStatus(listener: (status: TransportStatus) => void): () => void;
  /** Platform hint (foreground/network return); connection owner decides whether to retry. */
  subscribeRecoveryHint?(listener: () => void): () => void;
  close(): Promise<void>;
}
