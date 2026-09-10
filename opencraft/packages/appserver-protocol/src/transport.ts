import type { AppServerNotification } from "./methods";

export interface AppServerRequestOptions {
  timeoutMs?: number;
  priority?: "background" | "user-visible" | "user-blocking";
  signal?: AbortSignal;
}

export interface AppServerTransport {
  readonly hostId: string;
  request<TResult>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: AppServerRequestOptions,
  ): Promise<TResult>;
  subscribe(listener: (notification: AppServerNotification) => void): () => void;
  close(): Promise<void>;
}

/** Electron owns local/SSH process transports; the renderer only sees this host-aware port. */
export interface ElectronAppServerBridge {
  request<TResult>(input: {
    hostId: string;
    method: string;
    params: Readonly<Record<string, unknown>>;
    options?: AppServerRequestOptions;
  }): Promise<TResult>;
  subscribe(hostId: string, listener: (notification: AppServerNotification) => void): () => void;
}
