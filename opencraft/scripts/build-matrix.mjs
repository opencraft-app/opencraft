#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(repositoryRoot, "config/build-matrix.json");

function usage() {
  return [
    "Usage:",
    "  npm run matrix:list",
    "  npm run matrix:check",
    "  npm run matrix:build -- <target-id> [target-id...]",
  ].join("\n");
}

async function readMatrix() {
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix.targets)) {
    throw new Error("Unsupported build matrix schema");
  }
  const ids = new Set();
  for (const target of matrix.targets) {
    if (typeof target.id !== "string" || ids.has(target.id)) {
      throw new Error(`Invalid or duplicate build target: ${String(target.id)}`);
    }
    if (!Array.isArray(target.command) || target.command.length === 0) {
      throw new Error(`Build target ${target.id} has no command`);
    }
    ids.add(target.id);
  }
  return matrix;
}

function run(command) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Command failed (${signal ?? code}): ${command.join(" ")}`));
    });
  });
}

async function assertArtifacts(target) {
  const missing = [];
  for (const artifact of target.artifacts ?? []) {
    try {
      await access(resolve(repositoryRoot, artifact));
    } catch {
      missing.push(artifact);
    }
  }
  if (missing.length > 0) {
    throw new Error(`${target.id} did not produce:\n${missing.map((path) => `  - ${path}`).join("\n")}`);
  }
}

const matrix = await readMatrix();
const [operation = "list", ...requestedIds] = process.argv.slice(2);

if (operation === "list") {
  for (const target of matrix.targets) {
    process.stdout.write(`${target.id.padEnd(24)} ${target.platforms.join(",").padEnd(22)} ${target.description}\n`);
  }
} else if (operation === "check") {
  process.stdout.write(`Build matrix is valid (${matrix.targets.length} targets).\n`);
} else if (operation === "build") {
  if (requestedIds.length === 0) throw new Error(usage());
  const targetsById = new Map(matrix.targets.map((target) => [target.id, target]));
  for (const id of requestedIds) {
    const target = targetsById.get(id);
    if (target === undefined) throw new Error(`Unknown build target: ${id}\n${usage()}`);
    if (!target.platforms.includes(process.platform)) {
      throw new Error(`${id} does not support build host ${process.platform}`);
    }
    process.stdout.write(`\n==> Building ${id}\n`);
    await run(target.command);
    await assertArtifacts(target);
  }
} else {
  throw new Error(usage());
}
