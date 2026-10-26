type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;

/** Native/cache owns history. The control ledger owns topology, even after reload. */
export function projectThreadTopologyResult(method: string, result: unknown,
  topology: (id: string) => {parentThreadId:string|null;visibility:"visible"|"hidden"} | null): unknown {
  const source = object(result);
  if (!source) return result;
  const project = (value: unknown) => {
    const thread = object(value);
    const metadata = typeof thread?.id === "string" ? topology(thread.id) : null;
    return metadata ? {...thread,...metadata} : value;
  };
  if (method === "thread/list" && Array.isArray(source.data)) return {...source,data:source.data.map(project)};
  if (["thread/read","thread/start","thread/fork","thread/resume"].includes(method) && source.thread) return {...source,thread:project(source.thread)};
  return result;
}
