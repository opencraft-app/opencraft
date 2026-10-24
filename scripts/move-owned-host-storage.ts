import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { moveOwnedStorage, planOwnedStorageMove } from "../apps/opencraft-daemon/src/owned-storage-move.js";

try {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "direction": { type: "string", default: "current" }, "apply": { type: "boolean", default: false }, "help": { type: "boolean", default: false } } });
  if (values.help) {
    console.log("Usage: npx tsx scripts/move-owned-host-storage.ts --data-dir DIR [--direction current|legacy] [--apply]");
    console.log("Default: read-only plan. Before --apply stop every local/remote Host overlay owner and disable automatic restart, including older binaries.");
    console.log("Re-run the same command after interruption. Direction legacy reverses names using current data; it does not restore a backup or downgrade schema.");
  } else {
    if (!values["data-dir"]?.trim() || !["current", "legacy"].includes(values.direction)) throw new Error("An explicit --data-dir and direction current|legacy are required");
    const directory = resolve(values["data-dir"]), direction = values.direction as "current" | "legacy";
    const result = values.apply ? moveOwnedStorage(directory, direction) : planOwnedStorageMove(directory, direction);
    console.log(JSON.stringify({ apply: values.apply, ...result }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
