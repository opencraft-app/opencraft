import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readSandboxRuntimeConfiguration } from "./runtime.js";

export async function sandboxFileExists(path: string | URL): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Operator selection at the engine assembly boundary; never a task setting. */
export async function engineSandboxConfiguration(): Promise<string | undefined> {
  const explicit = process.env.OPENCRAFT_SANDBOX_CONFIG;
  const path = explicit ?? "/etc/opencraft/sandbox.json";
  if (!isAbsolute(path)) throw new Error("Execution sandbox configuration must be absolute");
  if (!explicit && !await sandboxFileExists(path)) return undefined;
  await readSandboxRuntimeConfiguration(path); // Configured but invalid always fails closed.
  return path;
}
