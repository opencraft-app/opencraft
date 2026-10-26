import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { CodexGenerationRegistry } from "./generation-registry.js";

/** Path-based resume is a read of an existing HOME, never an import into the default HOME. */
export async function generationThreadPath(registry: CodexGenerationRegistry, path: string, requestedId: string) {
  const canonical = await realpath(path);
  const owners = registry.list().filter(generation => canonical.startsWith(join(generation.runtimeDataDirectory, "runtime") + sep));
  if (owners.length !== 1) throw new Error("Thread path must belong to exactly one registered HOME");
  const file = await open(canonical, "r");
  let id: unknown;
  try {
    const prefix = Buffer.alloc(1024 * 1024), { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    const text = prefix.toString("utf8", 0, bytesRead), end = text.indexOf("\n");
    if (end < 0) throw new Error("Thread metadata record is missing");
    const record = JSON.parse(text.slice(0, end));
    if (record.type !== "session_meta") throw new Error("Thread metadata record is missing");
    id = record.payload?.id;
  } finally { await file.close(); }
  if (typeof id !== "string" || !id || (requestedId && requestedId !== id)) throw new Error("Thread path and identity disagree");
  registry.discover(id, owners[0]!.id); return id;
}
