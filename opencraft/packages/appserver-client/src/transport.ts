export type TransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "failed";

export interface TransportStatus {
  state: TransportState;
  reason?: string;
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
