import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRuntimeMachineId, parseRuntimeMachineIdentity, type RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import { configuredMachineName } from "./machine-identity-document.js";

const execFileAsync = promisify(execFile);

const machineIdPattern = /^[0-9a-f-]{36}$/iu;

async function initializeHostMachineId(dataDirectory: string, requestedId: string): Promise<string> {
  if (!isAbsolute(dataDirectory)) throw new Error("Host data directory must be absolute");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, "machine-id");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${requestedId}\n`, { flag: "wx", mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await unlink(temporary); }
  const machineId = (await readFile(path, "utf8")).trim();
  if (!machineIdPattern.test(machineId)) throw new Error("Invalid persisted Host machine ID");
  return machineId;
}

/** Bind an explicitly placed workspace to its trusted installation owner. */
export async function bindHostMachineIdentity(dataDirectory: string, machineId: string): Promise<void> {
  if (!isRuntimeMachineId(machineId)) throw new Error("Invalid assigned Host machine ID");
  if (await initializeHostMachineId(dataDirectory, machineId) !== machineId)
    throw new Error("Workspace belongs to a different Host machine");
}

/**
 * Node owner of the machine identity: `<dataDirectory>/machine-id`, created
 * once (exclusive temporary file, mode 0600, hard-linked into place) and never
 * rewritten. dataDirectory is supplied by the canonical directory resolver/explicit CLI.
 */
export async function readHostMachineIdentity(dataDirectory: string, machineName?: string): Promise<RuntimeMachineIdentity> {
  const configured = configuredMachineName(machineName);
  const machineId = await initializeHostMachineId(dataDirectory, randomUUID());
  let name = configured ?? hostname();
  if (configured === null && process.platform === "darwin") {
    try { name = (await execFileAsync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 })).stdout.trim() || name; }
    catch { /* ComputerName may be unavailable; hostname still identifies the machine. */ }
  }
  return parseRuntimeMachineIdentity({ machineId, name, platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux" });
}
