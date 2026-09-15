import { Service, type Context } from "@deepseek-ai/cordis";
import type { DurableSql, DurableStorageNative, DurableStoragePort } from "../types/storage.js";

export class DurableStorageService extends Service implements DurableStoragePort {
  readonly native: DurableStorageNative | null;
  readonly available: boolean;
  readonly sql: DurableSql | null;

  constructor(ctx: Context) {
    super(ctx, "storage");
    this.native = globalThis.durableStorage ?? null;
    this.available = this.native !== null;
    this.sql = this.native?.sql ?? null;
  }

  transactionSync<Result>(callback: () => Result): Result {
    if (!this.native) throw new Error("durable SQLite storage is unavailable");
    return this.native.transactionSync(callback);
  }
}
