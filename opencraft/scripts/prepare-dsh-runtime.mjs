#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchDshProviderLifecycle } from "./patch-dsh-provider-lifecycle.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function installLockedRuntime(runtime) {
  const args = ["ci", "--prefix", runtime, "--workspaces=false", "--omit=dev", "--no-audit", "--no-fund"];
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, npmCli ? [npmCli, ...args] : args, {
      cwd: runtime,
      stdio: "inherit",
      shell: !npmCli && process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`DSH npm ci failed (${signal ?? code})`)));
  });
}

/** The runtime is a separately locked installation, never a root workspace. */
export async function prepareDshRuntime({ root = repositoryRoot, install = installLockedRuntime } = {}) {
  const runtime = resolve(root, "runtime/dsh");
  // Read before invoking npm: npm otherwise walks up to the root package!
  const [manifestText, lockText] = await Promise.all([
    readFile(resolve(runtime, "package.json"), "utf8"),
    readFile(resolve(runtime, "package-lock.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  const version = manifest.dependencies?.["@deepseek-ai/dsh"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)
    || lock.packages?.[""]?.dependencies?.["@deepseek-ai/dsh"] !== version
    || lock.packages?.["node_modules/@deepseek-ai/dsh"]?.version !== version) {
    throw new Error("DSH requires matching exact versions in its manifest and lockfile");
  }
  const fingerprint = createHash("sha256")
    .update(manifestText).update(lockText)
    .update(`${process.platform}/${process.arch}/${process.versions.modules}`)
    .digest("hex");
  const stamp = resolve(runtime, ".opencraft-dsh-install.json");
  let previous;
  try { previous = JSON.parse(await readFile(stamp, "utf8")); } catch { /* no verified install */ }
  const executable = resolve(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  async function verify() {
    const installed = JSON.parse(await readFile(resolve(runtime, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
    if (installed.version !== version || !(await stat(executable)).isFile()) {
      throw new Error(`DSH installation does not contain the expected ${version} executable`);
    }
  }
  let valid = false;
  if (previous?.fingerprint === fingerprint) {
    try { await verify(); valid = true; } catch { /* incomplete install */ }
  }
  if (!valid) {
    await install(runtime);
    await verify();
    // Never mark a failed/incomplete installation ready.
    await writeFile(stamp, `${JSON.stringify({ fingerprint, version })}\n`, "utf8");
  }
  // Reapply/verify on every build, including an already installed runtime.
  await patchDshProviderLifecycle(runtime);
  console.log(`[opencraft] DSH runtime ${version} verified at ${runtime}`);
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDshRuntime();
}
