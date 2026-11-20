import { ThreadDirectory } from "@opencraft/app-host-server/thread-directory";
/** Hub directory reuses shared metadata/snapshot ownership; execution is volatile. */
export class DurableThreadCatalog extends ThreadDirectory {
  constructor(database: ConstructorParameters<typeof ThreadDirectory>[0], port: ConstructorParameters<typeof ThreadDirectory>[1], now = Date.now, intervalMs = 60_000) {
    super(database, {...port,connectionLocalExecution:true}, now, intervalMs);
  }
}
