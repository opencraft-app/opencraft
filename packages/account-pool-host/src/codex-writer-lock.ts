import { chmod, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Kernel-released SQLite lock, independent of the account database and native thread locks. */
export async function acquireCodexWriter(dataDirectory: string): Promise<() => void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(dataDirectory);
  const path = join(root, ".codex-writer.sqlite");
  const lock = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    // Old embedded versions and orphaned CLI children do not hold our new lock.
    // Linux server migration must also check their actual CODEX_HOME before opening stores.
    if (process.platform === "linux") {
      const home = join(root, "runtime");
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/u.test(pid) || Number(pid) === process.pid) continue;
        let command: string;
        let environment: string;
        try {
          command = await readFile(`/proc/${pid}/cmdline`, "utf8");
          if (!command.split("\0").includes("app-server")) continue;
          environment = await readFile(`/proc/${pid}/environ`, "utf8");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ESRCH" || code === "EACCES") continue;
          throw error;
        }
        const configured = environment.split("\0").find(value => value.startsWith("CODEX_HOME="))?.slice(11);
        if (!configured) continue;
        const resolved = await realpath(configured).catch(() => resolve(configured));
        if (resolved === home) throw new Error(`Codex writer PID ${pid} still owns this data directory`);
      }
    }
  } catch (error) {
    lock.close();
    throw new Error(`Codex data directory is already owned or cannot be locked: ${root}`, { cause: error });
  }
  let released = false;
  return () => { if (!released) { released = true; lock.close(); } };
}
