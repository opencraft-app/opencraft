import type { AppServerConnection } from "./appserver.ts";

/** Atomically removes all live topology owned by one frontend connection. */
export interface TransparentConnectionCleanupPort {
  close(connection: AppServerConnection): void;
}
