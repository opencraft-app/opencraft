import { execFileSync } from "node:child_process";
import { mkdirSync, chownSync, statSync } from "node:fs";
import { relative, sep, join, dirname, basename } from "node:path";
import { readdir, lstat, lchown, realpath } from "node:fs/promises";

/** Create only the configured private directories; never recursively change existing data ownership. */
export function generationDirectory(path: string, uid: number, gid: number): void {
  if (uid !== process.getuid!()) {
    // Run path creation without routing-owner privileges, including symlink races.
    execFileSync("mkdir", ["-p", "-m", "700", "--", path], { uid, gid, env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" });
    const owner = statSync(path);
    if (owner.uid !== uid || owner.gid !== gid) throw new Error("Generation directory execution identity mismatch");
    return;
  }
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!created) return;
  const directories = [created];
  for (const part of relative(created, path).split(sep).filter(Boolean)) directories.push(join(directories.at(-1)!, part));
  for (const directory of directories) {
    const owner = statSync(directory);
    if (owner.uid !== uid || owner.gid !== gid) chownSync(directory, uid, gid);
  }
}

/** The offline validation copy belongs to the execution user; symlink targets stay untouched. */
export async function generationCopyOwner(path: string, uid: number, gid: number): Promise<void> {
  const status = await lstat(path);
  if (status.uid !== uid || status.gid !== gid) await lchown(path, uid, gid);
  if (status.isDirectory()) for (const name of await readdir(path)) await generationCopyOwner(join(path, name), uid, gid);
}

export async function canonicalGenerationPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw reason;
    return join(await canonicalGenerationPath(dirname(path)), basename(path));
  }
}
