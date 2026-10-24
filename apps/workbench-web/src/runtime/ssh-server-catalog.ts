import { serverFetch } from "./server-context";
import { parseSshServerDescriptors, type SshServerDescriptor } from "@opencraft/app-host-protocol";

/** Optional remote profiles cannot take the local Server offline on failure. */
export async function readSshServerCatalog(fetchCatalog: typeof fetch = serverFetch): Promise<readonly SshServerDescriptor[]> {
  try {
    const response = await fetchCatalog("/__opencraft_ssh_servers", {
      credentials: "same-origin", signal: AbortSignal.timeout(5_000), cache: "no-store",
    });
    if (response.status === 404) return []; // Older packaged backends.
    if (!response.ok) throw new Error("Unavailable catalog");
    return parseSshServerDescriptors(await response.json());
  } catch {
    // Do not surface raw backend data or fabricate a usable remote profile.
    console.warn("[ssh-server-catalog] Remote connections unavailable");
    return [];
  }
}
