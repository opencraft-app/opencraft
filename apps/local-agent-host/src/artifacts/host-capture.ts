import { delimiter, isAbsolute } from 'node:path';
import type { ArtifactCatalog } from './catalog.js';
import { captureGeneratedOutputs } from './tool-output.js';

type Subscribe = (listener: (method: string, params: unknown) => void) => () => void;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Deployment wiring: extra deliverable roots as a path-delimited list. */
export function generatedFileRootsFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return (environment.OPENCRAFT_GENERATED_FILE_ROOTS ?? '').split(delimiter).map(root => root.trim()).filter(root => isAbsolute(root));
}

/**
 * Host-wide capture for every engine running in this host (dsh, ACP, pi and connected
 * agents). It subscribes once, independently of client connections, so each completed
 * item is catalogued exactly once per slot and nothing depends on a viewer being open.
 */
export class HostArtifactCapture {
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #unsubscribe: Array<() => void> = [];
  constructor(private readonly catalog: () => ArtifactCatalog, private readonly options: {
    readonly roots: () => readonly string[];
    readonly diagnostic?: (entry: Record<string, unknown>) => void;
    readonly scope?: string;
  }) {}
  observe(subscribe: Subscribe): this {
    this.#unsubscribe.push(subscribe((method, params) => this.notify(method, params)));
    return this;
  }
  notify(method: string, params: unknown): void {
    if (method !== 'item/completed' || this.#controller.signal.aborted) return;
    const value = record(params), item = record(value.item), threadId = typeof value.threadId === 'string' ? value.threadId : '';
    if (!threadId || !['imageGeneration', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(String(item.type))) return;
    const operation = captureGeneratedOutputs(this.catalog(), this.options.scope ?? 'host-generated', threadId, item,
      undefined, this.#controller.signal, { savedPathRoots: this.options.roots() })
      .catch(() => this.options.diagnostic?.({ event: 'artifact-output-save-failed', threadId, itemId: String(item.id ?? '') }));
    this.#pending.add(operation);
    void operation.finally(() => this.#pending.delete(operation));
  }
  /** Resolves when every capture started so far has settled. */
  async settled(): Promise<void> { await Promise.allSettled([...this.#pending]); }
  async close(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#controller.abort();
    await this.settled();
  }
}
