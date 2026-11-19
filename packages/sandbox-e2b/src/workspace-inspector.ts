/** Read-only adapter for the persistent-workspace API extension (schemaVersion 2).
 * Not part of the public E2B SDK and never enabled implicitly for other providers.
 * Inspection is a point-in-time observation, not a distributed allocation lock. */
export function createE2BPersistentWorkspaceInspector(
  options: {
    apiUrl: string;
    readApiKey(): Promise<string>;
    /** Authorize the durable binding before reading its provider metadata. */
    authorize(workspaceId: string): Promise<void>;
    requestTimeoutMs?: number;
  },
  request: typeof fetch = fetch,
) {
  const url = new URL(options.apiUrl),
    timeout = options.requestTimeoutMs ?? 15000;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > 120000
  )
    throw Error("Invalid workspace inspector configuration");
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  async function get(path: string, key: string, signal: AbortSignal): Promise<unknown> {
    const response = await request(url.origin + path, {
      method: "GET",
      headers: { "X-API-Key": key },
      redirect: "error",
      signal,
    });
    // Do not parse error bodies: they may contain provider diagnostics/secrets.
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error("Metadata unavailable");
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) throw Error("Metadata too large");
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  return async (binding: {
    workspaceId: string;
    privateVolumeId: string;
  }): Promise<"absent" | "present" | "unknown"> => {
    // Expected volume identity must come from a previously verified durable
    // receipt. A freshly observed replacement volume is not data retention proof.
    if (!/^ws-[a-f0-9]{32}$/.test(binding.workspaceId) || !uuid.test(binding.privateVolumeId)) return "unknown";
    try {
      await options.authorize(binding.workspaceId);
      const key = await options.readApiKey();
      if (typeof key !== "string" || !key || /[\r\n]/.test(key)) return "unknown";
      const signal = AbortSignal.timeout(timeout);
      const path = "/workspaces/" + binding.workspaceId;
      const classify = (value: unknown): "absent" | "present" | "unknown" => {
        if (
          !record(value) ||
          value.schemaVersion !== 2 ||
          value.workspaceID !== binding.workspaceId ||
          value.privateVolumeID !== binding.privateVolumeId ||
          !Array.isArray(value.members)
        )
          return "unknown";
        // Never infer an empty family from only the journal's previous instance.
        if (value.members.length) return "present";
        return value.phase === "ready" &&
          typeof value.generation === "number" &&
          Number.isSafeInteger(value.generation) &&
          value.generation >= 0
          ? "absent"
          : "unknown";
      };
      const first = await get(path, key, signal),
        state = classify(first);
      if (state !== "absent") {
        await options.authorize(binding.workspaceId);
        return state;
      }
      const volume = await get("/volumes/" + binding.privateVolumeId, key, signal);
      if (!record(volume) || volume.volumeID !== binding.privateVolumeId) return "unknown";
      // Check again after reading the volume: a new member or generation blocks
      // clearance. The subsequent create must still obey the provider's 409.
      const second = await get(path, key, signal);
      await options.authorize(binding.workspaceId);
      const final = classify(second);
      if (final !== "absent") return final;
      return record(first) && record(second) && first.generation === second.generation ? "absent" : "unknown";
    } catch {
      return "unknown";
    } // No provider messages or credentials escape.
  };
}
