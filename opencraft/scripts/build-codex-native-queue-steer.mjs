#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "00c972ed5d6ff6499317fd41b7f23605b8e6850d";
const tag = "rust-v0.157.0";
const patch = join(root, "runtime/codex/patches/queue-steer-rust-v0.157.0.patch");
const destination = join(root, "runtime/codex/native", `${process.platform}-${process.arch}`);

function run(command, args, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`)));
  });
}

async function output(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], shell: false });
    let data = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { data += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise(data.trim())
      : reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`)));
  });
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This release builder currently supports Linux x64 only");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "opencraft-codex-queue-steer-"));
const checkout = join(temporaryRoot, "codex");
try {
  await run("git", ["clone", "--depth=1", "--branch", tag, "--single-branch", "https://github.com/openai/codex.git", checkout], root);
  const actualRevision = await output("git", ["rev-parse", "HEAD"], checkout);
  if (actualRevision !== revision) {
    throw new Error(`Unexpected Codex source revision: ${actualRevision}`);
  }
  await run("git", ["apply", "--check", patch], checkout);
  await run("git", ["apply", patch], checkout);
  const cargo = process.env.OPENCRAFT_CARGO_EXECUTABLE || "cargo";
  const targetDirectory = process.env.OPENCRAFT_CODEX_TARGET_DIR
    || join(root, "runtime/codex/.build-target");
  await run(cargo, ["build", "--locked", "--release", "-p", "codex-cli", "--bin", "codex"], join(checkout, "codex-rs"), {
    ...process.env,
    CARGO_TARGET_DIR: targetDirectory,
  });
  await mkdir(destination, { recursive: true });
  const binaryPath = join(destination, "codex");
  await copyFile(join(targetDirectory, "release/codex"), binaryPath);
  await chmod(binaryPath, 0o755);
  const sha256 = createHash("sha256").update(await readFile(binaryPath)).digest("hex");
  const patchSha256 = createHash("sha256").update(await readFile(patch)).digest("hex");
  await writeFile(join(destination, "SOURCE.json"), `${JSON.stringify({ tag, revision, patchSha256, sha256 }, null, 2)}\n`);
  console.log(`Built patched Codex ${tag} (${sha256}) at ${binaryPath}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
