import assert from "node:assert/strict";
import nodeTest from "node:test";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
import { mkdtemp, rm, mkdir, chmod, symlink, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  personalGitSocketPaths,
  createPersonalGitSocketDirectory,
  removePersonalGitSocketDirectory,
} from "../../packages/execution-environment/src/personal-git-sockets.js";

const owner = "owner-0123456789ab",
  uid = process.getuid?.() ?? -1;
test("socket budget includes UTF-8 names and the signer suffix without moving runtime metadata", () => {
  const short = personalGitSocketPaths("/tmp/oc", owner, uid);
  assert.equal(short.root, null);
  assert.equal(short.directory, join("/tmp/oc", owner));
  for (const runtime of ["/tmp/" + "long".repeat(40), "/tmp/" + "目录".repeat(20)]) {
    const paths = personalGitSocketPaths(runtime, owner, uid);
    assert.ok(paths.root);
    assert.ok(Buffer.byteLength(paths.socket) <= 100);
    assert.ok(Buffer.byteLength(join(paths.directory, "sign-XXXXXX", "agent.sock")) <= 100);
    assert.deepEqual(personalGitSocketPaths(runtime, owner, uid), paths);
    assert.notEqual(personalGitSocketPaths(runtime + "other", owner, uid).root, paths.root);
  }
  for (const invalid of ["../owner-forged", "owner-../secret", "owner-0"])
    assert.throws(() => personalGitSocketPaths("/tmp/oc", invalid, uid));
});

test("short socket namespace is private, rejects takeover and never follows a substituted root", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "git-ipc-path-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const paths = personalGitSocketPaths(join(fixture, "deep".repeat(40)), owner, uid);
  assert.ok(paths.root);
  t.after(() => rm(paths.root!, { recursive: true, force: true }));
  await createPersonalGitSocketDirectory(paths, uid);
  assert.equal((await lstat(paths.directory)).mode & 0o777, 0o700);
  await assert.rejects(createPersonalGitSocketDirectory(paths, uid), { code: "EEXIST" });
  const peer = personalGitSocketPaths(join(fixture, "deep".repeat(40)), "owner-aaaaaaaaaaaa", uid);
  await createPersonalGitSocketDirectory(peer, uid);
  await removePersonalGitSocketDirectory(paths);
  assert.ok((await lstat(peer.directory)).isDirectory(), "Retiring one owner cannot remove a live peer");
  await removePersonalGitSocketDirectory(peer);
  await assert.rejects(lstat(paths.root), { code: "ENOENT" });
  await mkdir(paths.root, { mode: 0o700 });
  await chmod(paths.root, 0o755);
  await assert.rejects(createPersonalGitSocketDirectory(paths, uid), /socket_unavailable/);
  await rm(paths.root, { recursive: true, force: true });
  const target = join(fixture, "unrelated");
  await mkdir(target);
  await writeFile(join(target, "keep"), "untouched");
  await symlink(target, paths.root);
  await assert.rejects(createPersonalGitSocketDirectory(paths, uid), /socket_unavailable/);
  assert.equal(await readFile(join(target, "keep"), "utf8"), "untouched");
});
