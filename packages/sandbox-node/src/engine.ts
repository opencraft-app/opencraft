import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readSandboxRuntimeConfiguration } from "./runtime.js";

/** Operator selection at the engine assembly boundary; never a task setting. */
export async function engineSandboxConfiguration(): Promise<string | undefined> {
  const explicit = process.env.OPENCRAFT_SANDBOX_CONFIG;
  const path = explicit ?? "/etc/opencraft/sandbox.json";
  if (!isAbsolute(path)) throw new Error("Execution sandbox configuration must be absolute");
  if (!explicit && !existsSync(path)) return undefined;
  await readSandboxRuntimeConfiguration(path); // Configured but invalid always fails closed.
  return path;
}
