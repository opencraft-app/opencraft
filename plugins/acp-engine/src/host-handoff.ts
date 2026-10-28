import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

type Phase = "open" | "fenced" | "released" | "cold-ready";
interface State {
  schemaVersion: 1; epoch: number; phase: Phase;
  operationId?: string; fence?: string; sourceOwner?: string;
  ready?: { owner: string; identity: string };
}
export interface HostHandoffExpectation {
  expectedOwner: string; expectedEpoch: number; operationId: string; fence: string;
}
/** Persistent admission authority. A failed write poisons this incarnation;
 * even a post-rename failure cannot reopen admission from uncertain memory. */
export class AcpHostHandoff {
  private state: State = { schemaVersion: 1, epoch: 0, phase: "open" };
  private failed = false;
  private calls = 0;
  private sealed = false;
  private loading?: Promise<void>;
  constructor(private readonly directory: string, readonly owner: string, private readonly io = { open, rename }) {}
  load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const file = await open(join(this.directory, "host-handoff.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
        let state;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 65536) throw new Error("Private ACP handoff file required");
          state = JSON.parse(await file.readFile("utf8"));
        } finally { await file.close(); }
        if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.epoch) || state.epoch < 0
          || !["open", "fenced", "released", "cold-ready"].includes(state.phase)
          || state.phase !== "open" && (![state.operationId, state.fence, state.sourceOwner].every(v => typeof v === "string" && v.length > 0)))
          throw new Error("Invalid ACP Host handoff state");
        this.state = state;
        if (state.phase === "fenced" && state.sourceOwner !== this.owner)
          throw new Error("ACP old writer release is unconfirmed");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.failed = true; throw error; } }
    })();
  }
  private async save(state: State): Promise<void> {
    const path = join(this.directory, "host-handoff.json"), temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await this.io.open(temporary, "wx", 0o600); await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = undefined;
      await this.io.rename(temporary, path);
      const directory = await this.io.open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
      this.state = state;
    } catch (error) { this.failed = true; throw error; }
    finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async run<T>(operation: () => Promise<T>, reconciliation = false): Promise<T> {
    if (this.failed || this.sealed || this.state.phase !== "open" && !reconciliation) throw new Error("ACP Host admission is fenced");
    this.calls++;
    try { return await operation(); } finally { this.calls--; }
  }
  snapshot() { return { ...structuredClone(this.state), owner: this.owner, activeCalls: this.calls, persistence: this.failed ? "unknown" : "ready" }; }
  private check(input: HostHandoffExpectation, existing = true): void {
    if (this.failed || input.expectedOwner !== this.owner || input.expectedEpoch !== this.state.epoch
      || ![input.operationId, input.fence].every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(v))
      || existing && (input.operationId !== this.state.operationId || input.fence !== this.state.fence)) throw new Error("ACP Host handoff conflict");
  }
  async fence(input: HostHandoffExpectation): Promise<void> {
    this.check(input, this.state.phase !== "open");
    if (this.state.phase !== "open") return;
    // Close synchronously before the durable boundary. Prior accepted calls are
    // counted until their entire operation settles, including binding writes.
    this.state = { schemaVersion: 1, epoch: this.state.epoch + 1, phase: "fenced", operationId: input.operationId, fence: input.fence, sourceOwner: this.owner };
    await this.save(this.state);
  }
  async release(input: HostHandoffExpectation, drain: () => { activeCount: number | null; coverage: string }, stop: () => Promise<void>): Promise<void> {
    this.check(input);
    if (this.state.phase === "released") return;
    const proof = drain();
    if (this.state.phase !== "fenced" || proof.coverage !== "complete" || proof.activeCount !== 0 || this.calls !== 0) throw new Error("ACP Host is not drained");
    this.sealed = true;
    await stop();
    await this.save({ ...this.state, phase: "released" });
  }
  async coldReady(input: HostHandoffExpectation, proof: unknown): Promise<void> {
    this.check(input);
    if (!["released", "cold-ready"].includes(this.state.phase) || this.state.sourceOwner === this.owner) throw new Error("ACP Host cold successor required");
    const identity = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
    await this.save({ ...this.state, phase: "cold-ready", ready: { owner: this.owner, identity } });
  }
  async resume(input: HostHandoffExpectation, identity: string, proof: unknown): Promise<void> {
    this.check(input);
    if (this.state.phase !== "cold-ready" || this.state.ready?.owner !== this.owner || this.state.ready.identity !== identity || createHash("sha256").update(JSON.stringify(proof)).digest("hex") !== identity) throw new Error("ACP Host cold readiness changed");
    await this.save({ ...this.state, phase: "open" });
  }
}
