#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mono2Root = resolve(repositoryRoot, "..");
const manifestName = "UPSTREAM.json";
const packageSpecs = [
  {
    source: "shared/lightvela-agent-core",
    target: "packages/lightvela-agent-core",
  },
  {
    source: "shared/vela-chat-client-core",
    target: "packages/vela-chat-client-core",
  },
];

async function listFiles(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === manifestName
      || entry.name === "AGENTS.md" || entry.name.endsWith(".test.ts")) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) await listFiles(root, path, result);
    else if (entry.isFile()) result.push(relative(root, path));
  }
  return result;
}

async function packageSnapshot(root) {
  const files = await listFiles(root);
  files.sort();
  const hash = createHash("sha256");
  const entries = [];
  for (const file of files) {
    const contents = await snapshotContents(root, file);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    entries.push({ file, sha256 });
    hash.update(file).update("\0").update(contents).update("\0");
  }
  return { digest: hash.digest("hex"), entries };
}

async function snapshotContents(root, file) {
  const contents = await readFile(join(root, file));
  if (file !== "package.json") return contents;
  const manifest = JSON.parse(contents.toString("utf8"));
  delete manifest.devDependencies;
  delete manifest.scripts;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function sourceExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function syncSharedPackages({ check = false } = {}) {
  for (const spec of packageSpecs) {
    const source = resolve(mono2Root, spec.source);
    const target = resolve(repositoryRoot, spec.target);
    const hasSource = await sourceExists(source);
    if (!hasSource && !check) throw new Error(`Shared package source is unavailable: ${spec.source}`);

    if (!check) {
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      const snapshot = await packageSnapshot(source);
      for (const { file } of snapshot.entries) {
        const destination = join(target, file);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await snapshotContents(source, file));
      }
      await writeFile(join(target, manifestName), `${JSON.stringify({
        schemaVersion: 1,
        source: spec.source,
        digest: snapshot.digest,
        files: snapshot.entries,
      }, null, 2)}\n`);
    }

    const manifest = JSON.parse(await readFile(join(target, manifestName), "utf8"));
    const targetSnapshot = await packageSnapshot(target);
    if (manifest.schemaVersion !== 1 || manifest.source !== spec.source || manifest.digest !== targetSnapshot.digest) {
      throw new Error(`Shared package snapshot drift: ${spec.target}`);
    }
    if (hasSource) {
      const sourceSnapshot = await packageSnapshot(source);
      if (sourceSnapshot.digest !== targetSnapshot.digest) {
        throw new Error(`Shared package source drift: ${spec.source}`);
      }
    }
    process.stdout.write(`[opencraft] ${spec.target} ${targetSnapshot.digest}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncSharedPackages({ check: process.argv.includes("--check") });
}
