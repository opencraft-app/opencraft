import type { QueryClient } from "@tanstack/react-query";
import type { ThreadIdentity } from "@opencraft/workbench-runtime";
type Catalog = { data?: Array<{ id: string; name?: string | null; preview?: string }>; pages?: Catalog[] };
export function readCachedThreadName(query: QueryClient, key: ThreadIdentity): string {
  let preview = "";
  for (const [, data] of query.getQueriesData<Catalog>({ queryKey: ["appserver", key.hostId, "threads"] })) {
    for (const page of data?.pages ?? [data]) {
      const thread = page?.data?.find(thread => thread.id === key.threadId);
      if (thread?.name?.trim()) return thread.name;
      preview ||= thread?.preview?.trim() ?? "";
    }
  }
  return preview || "New chat";
}
export function writeCachedThreadName(query: QueryClient, key: ThreadIdentity, name: string): void {
  const patch = (data: Catalog | undefined): Catalog | undefined => data && {
    ...data, ...(data.pages ? { pages: data.pages.map(page => patch(page)!) } : {}),
    ...(data.data ? { data: data.data.map(thread => thread.id === key.threadId ? { ...thread, name } : thread) } : {}),
  };
  query.setQueriesData<Catalog>({ queryKey: ["appserver", key.hostId, "threads"] }, patch);
}
