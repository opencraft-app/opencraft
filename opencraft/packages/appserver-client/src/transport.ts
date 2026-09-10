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
  subscribeMessage(listener: (frame: string) => void): () => void;
  subscribeStatus(listener: (status: TransportStatus) => void): () => void;
  close(): Promise<void>;
}
