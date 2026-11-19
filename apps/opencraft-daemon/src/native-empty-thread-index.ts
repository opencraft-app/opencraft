type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Confirm pagination before publishing a durable, newly allocated native thread. */
export async function ensureNativeCreationIndex(threadId: string, request: NativeRequest): Promise<void> {
  const probe = async () => {
    const page = record(
      await request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }),
    );
    if (!Array.isArray(page.data)) throw new Error("Native creation index was not confirmed");
  };
  try {
    await probe();
    return;
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      record(cause).code !== -32601 ||
      cause.message !== "list_turns is not supported yet"
    )
      throw cause;
  }
  const thread = record(record(await request("thread/read", { threadId, includeTurns: false })).thread);
  if (
    thread.id !== threadId ||
    thread.historyMode !== "paginated" ||
    thread.ephemeral !== false ||
    record(thread.status).type !== "idle" ||
    !(thread.projectId === null || (typeof thread.projectId === "string" && thread.projectId.length > 0))
  ) {
    throw new Error("Native creation cannot safely confirm its index");
  }
  // Native owns its pending metadata and index. A same-value project update on
  // the live allocation flushes canonical metadata, without a Turn or Host SQL.
  const updated = record(
    record(await request("thread/metadata/update", { threadId, projectId: thread.projectId ?? "" })).thread,
  );
  if (updated.id !== threadId || updated.projectId !== thread.projectId)
    throw new Error("Native creation metadata was not confirmed");
  await probe();
}
