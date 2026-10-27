import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseRuntimeMachineIdentity, type RuntimeMachineIdentity } from "@opencraft/appserver-protocol";

/** A deployment may name the machine; the name never changes machineId. */
function configuredMachineName(value: string | undefined): string | null {
  const name = value?.trim() ?? "";
  if (name === "") return null;
  if (name.length > 64 || /\p{Cc}/u.test(name)) throw new Error("--machine-name must be at most 64 characters without control characters");
  return name;
}

/** dataDirectory is supplied by the canonical directory resolver/explicit CLI. */
export async function readDaemonMachineIdentity(dataDirectory: string, machineName?: string): Promise<RuntimeMachineIdentity> {
  const configured = configuredMachineName(machineName);
  if (!isAbsolute(dataDirectory)) throw new Error("Daemon data directory must be absolute");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, "machine-id");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await unlink(temporary); }
  const machineId = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-f-]{36}$/i.test(machineId)) throw new Error("Invalid persisted daemon machine ID");
  let name = configured ?? hostname();
  if (configured === null && process.platform === "darwin") {
    try { name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim() || name; }
    catch { /* ComputerName may be unavailable; hostname still identifies the machine. */ }
  }
  return parseRuntimeMachineIdentity({ machineId, name, platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux" });
}
