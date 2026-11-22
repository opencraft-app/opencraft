import { createHash } from "node:crypto";
import { lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Metadata stays in the canonical runtime. Only IPC endpoints need the short
 * private namespace: Unix sun_path counts UTF-8 bytes, including signer suffixes. */
export function personalGitSocketPaths(runtime: string, owner: string, uid: number) {
  if (!isAbsolute(runtime) || !/^owner-[a-f0-9]{12}$/u.test(owner) || !Number.isSafeInteger(uid) || uid < 0)
    throw Error("personal_git_socket_unavailable");
  const metadata = join(runtime, owner);
  if (Buffer.byteLength(join(metadata, "sign-XXXXXX", "agent.sock")) <= 100)
    return { directory: metadata, socket: join(metadata, "broker.sock"), root: null };
  // Do not inherit an arbitrarily deep TMPDIR. No credential is stored here.
  const root = join("/tmp", `ocg-${uid}-${createHash("sha256").update(runtime).digest("hex").slice(0, 16)}`);
  const directory = join(root, owner.slice("owner-".length));
  return { directory, socket: join(directory, "broker.sock"), root };
}

export async function createPersonalGitSocketDirectory(paths: ReturnType<typeof personalGitSocketPaths>, uid: number) {
  if (!paths.root) return; // The canonical owner directory was already created.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(paths.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      await assertPersonalGitSocketDirectory(paths.root, uid);
    } catch (error) {
      if (attempt === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Never take over an existing owner, even if it has the same UID.
    try {
      await mkdir(paths.directory, { mode: 0o700 });
    } catch (error) {
      // Another retiring owner may remove the now-empty shared root. ENOENT
      // proves no child was allocated; never retry an unknown creation result.
      if (attempt === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await assertPersonalGitSocketDirectory(paths.directory, uid);
    return;
  }
}

export async function removePersonalGitSocketDirectory(paths: ReturnType<typeof personalGitSocketPaths>) {
  if (!paths.root) return;
  await rm(paths.directory, { recursive: true, force: true });
  try {
    await rmdir(paths.root);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

export async function assertPersonalGitSocketDirectory(path: string, uid: number) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.uid !== uid || entry.mode & 0o077) throw Error("personal_git_socket_unavailable");
}
