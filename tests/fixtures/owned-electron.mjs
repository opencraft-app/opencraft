import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { electronExecutableName } from "../../scripts/electron-distribution.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function ownedDesktopFixture(t) {
  const distribution = await mkdtemp(join(tmpdir(), "owned-desktop-"));
  t.after(() => rm(distribution, { recursive: true, force: true }));
  const definition = await readFile(new URL("../../vendor/electron/fork.json", import.meta.url));
  const fork = JSON.parse(definition),
    executable = electronExecutableName().split("\\").join("/");
  await mkdir(dirname(join(distribution, executable)), { recursive: true });
  const bytes = Buffer.from("fixture native Electron");
  await writeFile(join(distribution, executable), bytes);
  await chmod(join(distribution, executable), 0o755);
  const marker = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    electronVersion: fork.version,
    chromiumVersion: fork.chromiumVersion,
    forkDefinitionSha256: hash(definition),
    nativeProbePassed: true,
    executable,
    executableSha256: hash(bytes),
    files: [{ path: executable, type: "file", size: bytes.length, sha256: hash(bytes) }],
  };
  await writeFile(join(distribution, "opencraft-electron-desktop-artifact.json"), JSON.stringify(marker));
  return distribution;
}
