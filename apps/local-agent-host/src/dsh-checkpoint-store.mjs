import { mkdir, readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

/** A serialized, flush-before-commit source-surface checkpoint. */
export class DshCheckpointStore {
  constructor(root, projection) { this.root = root; this.projection = projection; this.tails = new Map(); this.transitions = new Map(); }
  transition(logicalSessionId, operation) {
    const previous = this.transitions.get(logicalSessionId) ?? Promise.resolve();
    const next = previous.then(operation);
    this.transitions.set(logicalSessionId, next.catch(() => {}));
    return next;
  }
  async list() {
    let names;
    try { names = await readdir(this.root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const result = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = JSON.parse(await readFile(join(this.root, name), "utf8"));
      if (typeof value.logicalSessionId !== "string" || this.path(value.logicalSessionId) !== join(this.root, name)) throw new Error("Checkpoint file identity mismatch");
      result.push(await this.read(value.logicalSessionId));
    }
    return result;
  }
  path(logicalSessionId) { return join(this.root, createHash("sha256").update(logicalSessionId).digest("hex") + ".json"); }
  intentPath(logicalSessionId) { return this.path(logicalSessionId) + ".intent"; }
  async readIntent(logicalSessionId) {
    try {
      const intent = JSON.parse(await readFile(this.intentPath(logicalSessionId), "utf8"));
      if (intent.version !== 1 || intent.input?.logicalSessionId !== logicalSessionId ||
          typeof intent.prepared?.sessionId !== "string" || !Array.isArray(intent.prepared.seed)) throw new Error("Invalid DSH generation intent");
      return intent;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async writeIntent(input, prepared) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.intentPath(input.logicalSessionId);
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify({ version: 1, input, prepared }), { mode: 0o600 });
    try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async clearIntent(logicalSessionId) {
    await unlink(this.intentPath(logicalSessionId)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  async read(logicalSessionId) {
    try {
      const value = JSON.parse(await readFile(this.path(logicalSessionId), "utf8"));
      if (value.version !== 1 || value.logicalSessionId !== logicalSessionId ||
          typeof value.sourceSessionId !== "string" || !value.sourceSessionId ||
          !Number.isSafeInteger(value.generation) || value.generation < 0 ||
          !Number.isSafeInteger(value.capturedThroughSeq) || value.capturedThroughSeq < -1 ||
          !Array.isArray(value.surfaceEvents)) throw new Error("Invalid DSH checkpoint");
      return value;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  capture(logicalSessionId, session, generation, flush, seedCoordinates) {
    const previous = this.tails.get(logicalSessionId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = await this.read(logicalSessionId);
      if (current && current.generation > generation) throw new Error("Stale generation cannot overwrite checkpoint");
      if (current && current.generation === generation &&
          (current.sourceSessionId !== String(session.id ?? session.header.id) || current.capturedThroughSeq > session.events.length - 1)) {
        throw new Error("Checkpoint source or watermark would move backwards");
      }
      await flush(session);
      // No await between watermark and surface snapshot: they are one frame.
      const value = { version: 1, logicalSessionId, sourceSessionId: String(session.id ?? session.header.id),
        generation, capturedThroughSeq: session.events.length - 1, header: structuredClone(session.header),
        surfaceEvents: this.projection.currentSurfaceEvents(session), updatedAtMs: Date.now() };
      const seed = seedCoordinates ?? (current?.generation === generation ? current.seedCoordinates : undefined);
      if (seed) value.seedCoordinates = structuredClone(seed);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = this.path(logicalSessionId) + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
      try { await rename(temporary, this.path(logicalSessionId)); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      return value;
    });
    this.tails.set(logicalSessionId, operation.catch(() => {}));
    return operation;
  }
  async prepare(logicalSessionId, requestedSessionId, readTail) {
    await this.tails.get(logicalSessionId);
    const checkpoint = await this.read(logicalSessionId);
    if (!checkpoint) return null;
    if (checkpoint.sourceSessionId !== requestedSessionId) throw new Error("Checkpoint source generation does not match requested session");
    const tail = await readTail(requestedSessionId, checkpoint.capturedThroughSeq + 1);
    const surface = this.projection.advanceSurface(checkpoint.surfaceEvents, tail);
    const open = new Set();
    for (const event of tail) {
      if (event.type === "turn/start") open.add(event.data?.turn);
      if (event.type === "turn/end") open.delete(event.data?.turn);
    }
    const interrupted = open.size > 0;
    const generation = checkpoint.generation + 1;
    return { sessionId: logicalSessionId + ".g" + generation, generation,
      seed: this.projection.surfaceToSeed(surface, { interrupted }), interruptedTurns: interrupted ? 1 : 0,
      sourceSessionId: requestedSessionId };
  }
}
