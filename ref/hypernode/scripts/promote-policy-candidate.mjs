import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [candidateArg, revision] = process.argv.slice(2);
if (!candidateArg || !revision) {
  fail("usage: npm run promote:policy -- <candidate.js> <revision>");
}
if (!/^[a-zA-Z0-9._-]{1,128}$/.test(revision)) fail("revision contains unsafe characters");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = resolve(process.cwd(), candidateArg);
const info = await lstat(candidate).catch(() => null);
if (!info?.isFile() || info.isSymbolicLink()) fail("candidate must be a regular non-symlink file");
const source = await readFile(candidate);
if (source.length === 0 || source.length > 8 * 1024 * 1024) fail("candidate bundle size is invalid");
if (!source.includes(Buffer.from("hypernodeHotCandidate"))) {
  fail("candidate must assign globalThis.hypernodeHotCandidate");
}

const gates = [
  ["npm", ["run", "check:policy"]],
  ["npm", ["run", "test:policy"]],
  ["go", ["test", "./..."]],
];
for (const [command, args] of gates) {
  console.error(`gate: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) fail(`promotion gate failed: ${command} ${args.join(" ")}`);
}

const digest = createHash("sha256").update(source).digest("hex");
const releases = join(root, "policy", "releases");
await mkdir(releases, { recursive: true, mode: 0o750 });
const bundleName = `${revision}-${digest.slice(0, 16)}.js`;
const bundlePath = join(releases, bundleName);
if (resolve(candidate) !== resolve(bundlePath)) await copyFile(candidate, bundlePath);
const manifest = JSON.stringify({
  version: 1,
  slot: "evolution",
  revision,
  bundle: basename(bundlePath),
  sha256: digest,
}, null, 2) + "\n";
const temporary = join(releases, `.active-${process.pid}-${Date.now()}.json`);
await writeFile(temporary, manifest, { mode: 0o640, flag: "wx" });
await rename(temporary, join(releases, "active.json"));
console.log(`promoted ${revision} (${digest})`);
