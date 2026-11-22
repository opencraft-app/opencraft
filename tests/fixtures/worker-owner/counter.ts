import { writeFileSync } from "node:fs";
import { WorkerOwnerFatal } from "../../../packages/worker-owner/src/serve.ts";

export class CounterError extends Error {
  constructor(
    readonly code: "negative",
    readonly status = 400,
  ) {
    super(code);
    this.name = "CounterError";
  }
}

/** A synchronous owner, as a SQLite store would be. */
export class Counter {
  private value = 0;
  constructor(private readonly closedMarker?: string) {}
  add(amount: number): number {
    if (amount < 0) throw new CounterError("negative");
    this.value += amount;
    return this.value;
  }
  async slowAdd(amount: number, delayMs: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return this.add(amount);
  }
  lose(): never {
    throw new WorkerOwnerFatal("handle lost");
  }
  crash(): never {
    process.exit(3);
  }
  close(): void {
    if (this.closedMarker) writeFileSync(this.closedMarker, String(this.value));
  }
}
