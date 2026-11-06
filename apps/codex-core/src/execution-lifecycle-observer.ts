import {open, stat} from "node:fs/promises";

/** Positive executor exit evidence is independent of a possibly stuck Native RPC.
 * Only this owner's newly appended runner metadata is observed, never old logs. */
export class ExecutionLifecycleObserver {
  private offset = 0;
  private partial = "";
  private readonly started = new Set<number>();
  private readonly lost = new Set<number>();
  private flight: Promise<boolean> | undefined;
  constructor(private readonly path: string, private readonly ownerPid: number) {}
  async initialize(): Promise<void> {
    try {this.offset = (await stat(this.path)).size;}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  }
  disconnected(): Promise<boolean> {
    return this.flight ??= this.read().finally(() => {this.flight = undefined;});
  }
  private async read(): Promise<boolean> {
    let file;
    try {file = await open(this.path, "r");}
    catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.lost.size > 0; throw error;}
    try {
      const size = (await file.stat()).size;
      if (size < this.offset) {this.offset = 0; this.partial = "";}
      // Startup seeks past old history. Runtime records are tiny and emitted
      // only on transitions; bound each observation even if diagnostics grow.
      const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(0, size - this.offset)));
      const {bytesRead} = await file.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      const lines = (this.partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      this.partial = lines.pop() ?? "";
      if (this.partial.length > 16 * 1024) this.partial = "";
      for (const line of lines) {
        let row: any; try {row = JSON.parse(line);} catch {continue;}
        if (!row || row.ownerPid !== this.ownerPid || !Number.isSafeInteger(row.pid) || row.pid < 1) continue;
        if (row.event === "started") {this.started.add(row.pid); this.lost.delete(row.pid);}
        if ((row.event === "unit-exited" || row.event === "closed") && this.started.has(row.pid)) this.lost.add(row.pid);
      }
      return this.lost.size > 0;
    } finally {await file.close();}
  }
}
