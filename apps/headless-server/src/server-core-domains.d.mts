import type { CommitFence } from "@opencraft/access-control/commit-fence";
import type { ServerDatabaseHandle } from "@opencraft/storage-node/server-repository";

/** The core domains a Server core owner serves on its own connection (server-core-domains.mjs). */
export interface ServerCoreDomains {
  readonly methods: Readonly<Record<string, (...args: never[]) => unknown>>;
  close(): Promise<void>;
}

export function serverCoreDomains(
  owner: ServerDatabaseHandle,
  options?: { readonly identityFence?: CommitFence | undefined },
): ServerCoreDomains;
