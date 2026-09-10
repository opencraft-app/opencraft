import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import type { HostConnectionJson, HostConnectionProvider, HostConnectionProviderContext } from "./host-connections";
import { throwIfSignalAborted } from "./abort-signal";

/** A disposable protocol session, never a resident Host or a conversation. */
export async function preflightHostConnection(
  provider: HostConnectionProvider,
  config: HostConnectionJson,
  context: HostConnectionProviderContext,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  throwIfSignalAborted(options.signal);
  const abort = new AbortController();
  const cancel = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => abort.abort(new Error("Connection verification timed out")), options.timeoutMs ?? 10_000);
  let client: JsonRpcAppServerClient | undefined;
  try {
    if (provider.preflight !== undefined) {
      let rejectAborted: (() => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(abort.signal.reason ?? new Error("Connection verification cancelled"));
        if (abort.signal.aborted) rejectAborted();
        else abort.signal.addEventListener("abort", rejectAborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.resolve(provider.preflight(config, context, { signal: abort.signal })),
          aborted,
        ]);
      } finally {
        if (rejectAborted !== null) abort.signal.removeEventListener("abort", rejectAborted);
      }
      throwIfSignalAborted(abort.signal);
      return;
    }
    client = new JsonRpcAppServerClient({ hostId: context.hostId, transport: provider.createTransport(config, context) });
    const result = await client.connect({
      clientInfo: { name: "opencraft-connection-preflight", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, abort.signal);
    if (!result || typeof result.userAgent !== "string" || !result.userAgent.trim()) {
      throw new Error("Endpoint did not return a valid AppServer initialize response");
    }
    throwIfSignalAborted(abort.signal);
  } catch (error) {
    throw new Error(`Connection verification failed: ${abort.signal.aborted
      ? String(abort.signal.reason instanceof Error ? abort.signal.reason.message : "Cancelled")
      : error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    await client?.close();
  }
}
