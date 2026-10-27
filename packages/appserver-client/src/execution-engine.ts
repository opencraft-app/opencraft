/** Trusted server composition port. This is not a browser extension permission. */
export interface ExecutionEngineClient {
  request(method: string, params: Record<string, unknown>): Promise<any>;
  notify(method: string, params: Record<string, unknown>): void;
}

export interface ExecutionEngineProvider {
  readonly id: string;
  readonly label: string;
  readonly threadPrefix?: string;
  readonly modelPrefix?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly storageOutcomes?: readonly unknown[];
  start?(): Promise<void>;
  ownsThread(id: string): boolean;
  ownsModel(id: string): boolean;
  request(method: string, params: Record<string, any>, client: ExecutionEngineClient): Promise<any>;
  subscribe(listener: (method: string, params: Record<string, any>) => void): () => void;
  disconnect(client: ExecutionEngineClient): void;
  close(): Promise<void>;
}

/** A provider declaration is a complete capability set for its own threads. */
export function executionEngineExtension(extensions: Readonly<Record<string, any>> | null | undefined, threadId: string | null | undefined, key: string): any {
  const engines = extensions?.["opencraft/execution-engines"]?.providers;
  if (threadId && Array.isArray(engines)) {
    const engine = engines.find((entry: any) => (typeof entry.threadPrefix === "string" && entry.threadPrefix.length > 0 && threadId.startsWith(entry.threadPrefix)) || (typeof entry.modelPrefix === "string" && entry.modelPrefix.length > 0 && threadId.startsWith(entry.modelPrefix)));
    if (engine) return engine.extensions?.[key];
  }
  return extensions?.[key];
}
