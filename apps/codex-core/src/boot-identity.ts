import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

type Run = (file: string, args: readonly string[]) => Promise<string>;
const run: Run = async (file, args) =>
  (await promisify(execFile)(file, args, { timeout: 15_000, windowsHide: true })).stdout;

/**
 * An identity that changes on every host boot. On Linux it is the kernel boot ID,
 * unchanged from earlier releases so persisted owner state keeps matching.
 */
export async function bootIdentity(platform: NodeJS.Platform = process.platform, execute: Run = run): Promise<string> {
  let value: string;
  if (platform === "linux") value = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
  else if (platform === "darwin") value = await execute("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
  else if (platform === "win32") {
    value = await execute(
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc()",
      ],
    );
  } else throw new Error("Host boot identity is unavailable on this platform");
  value = value.trim();
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(value)) throw new Error("Host boot identity is unavailable");
  return value;
}
