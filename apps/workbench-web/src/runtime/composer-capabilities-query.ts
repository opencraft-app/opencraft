import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { CatalogModel as Model } from "@opencraft/appserver-protocol";
import { reasoningCapability } from "@opencraft/composer-core";

interface Page<T> { readonly data: readonly T[]; readonly nextCursor?: string | null }
export interface CapabilitiesReader {
  listModels(params: { cursor: string | null; limit: number; includeHidden: boolean; threadId?: string }): Promise<Page<Model>>;
}
export const composerCapabilitiesKey = (hostId: string) => ["appserver", hostId, "composer-capabilities"] as const;

async function readPages<T>(read: (cursor: string | null) => Promise<Page<T>>, signal: AbortSignal): Promise<T[]> {
  const values: T[] = [], cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await read(cursor);
    signal.throwIfAborted();
    values.push(...page.data);
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error("能力目录分页重复，请重试");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return values;
}

/** Publish the complete paginated model projection as one query snapshot. */
export function composerCapabilitiesOptions(hostId: string, threadId: string | null, reader: CapabilitiesReader) {
  return queryOptions({
    queryKey: [...composerCapabilitiesKey(hostId), { threadId }],
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const models = await readPages(
        cursor => reader.listModels({ cursor, limit: 100, includeHidden: false, ...(threadId === null ? {} : { threadId }) }),
        signal,
      );
      // Existing RPC ports cannot abort transport I/O, but cancelled results
      // must never publish, even if the transport resolves much later.
      signal.throwIfAborted();
      for (const model of models) reasoningCapability(model.supportedReasoningEfforts.map(e=>e.reasoningEffort),model.defaultReasoningEffort);
      return { models, metadataReader: reader };
    },
  });
}

export async function invalidateComposerCapabilities(client: QueryClient, hostId: string): Promise<void> {
  const filters = { queryKey: composerCapabilitiesKey(hostId) };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}

export const changesComposerCapabilities = (method: string) => [
  "runtime/providers/apply", "runtime/providers/setEnabled", "runtime/providers/delete",
  "runtime/providers/reapply",
  "runtime/models/setEnabled", "runtime/models/delete", "runtime/settings/mutate",
].includes(method);

/** Reuse completed metadata only within the same Host runtime. The scoped query
 * remains the sole source of selectable choices and submission validation. */
export function cachedComposerModelMetadata(client: QueryClient, hostId: string, reader: CapabilitiesReader): readonly Model[] {
  const models = new Map<string, Model>();
  const queries = client.getQueryCache().findAll({ queryKey: composerCapabilitiesKey(hostId) })
    .filter(query => (query.state.data as { metadataReader?: CapabilitiesReader } | undefined)?.metadataReader === reader)
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  for (const query of queries) {
    const data = query.state.data as { models: readonly Model[] };
    for (const model of data.models) models.set(model.id, model);
  }
  return [...models.values()];
}
