#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Release input may not contain symlinks or special files: ${path}`);
    }
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

async function writeAtomic(destination, contents) {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = join(
    dirname(destination),
    `.${destination.split(sep).at(-1)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o644);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, destination);
}

async function copyImmutableAsset(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  if (await pathExists(destination)) {
    const [sourceContents, destinationContents] = await Promise.all([
      readFile(source),
      readFile(destination),
    ]);
    if (sha256(sourceContents) !== sha256(destinationContents)) {
      throw new Error(`Immutable asset collision at ${destination}`);
    }
    return false;
  }

  const temporaryPath = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await copyFile(source, temporaryPath);
  try {
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (error?.code !== "EEXIST") throw error;
    return copyImmutableAsset(source, destination);
  }
  return true;
}

function parseReleaseVersion(contents, sourcePath) {
  let version;
  try {
    version = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid release metadata at ${sourcePath}: ${error.message}`);
  }
  if (
    version?.schemaVersion !== 1
    || typeof version.buildId !== "string"
    || !/^[a-zA-Z0-9._-]{1,128}$/u.test(version.buildId)
  ) {
    throw new Error(`Unsupported release metadata at ${sourcePath}`);
  }
  return version;
}

function assertBuildIdInIndex(indexHtml, buildId) {
  const escapedBuildId = buildId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const buildMeta = new RegExp(
    `<meta\\b(?=[^>]*name=["']opencraft-build-id["'])(?=[^>]*content=["']${escapedBuildId}["'])[^>]*>`,
    "iu",
  );
  if (!buildMeta.test(indexHtml)) {
    throw new Error(`index.html does not identify build ${buildId}`);
  }
}

function assertHashedAsset(relativePath) {
  if (!/^assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/u.test(relativePath)) {
    throw new Error(`Vite asset is not content-addressed: ${relativePath}`);
  }
}

function isContentHashedAsset(relativePath) {
  return /^assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/u.test(relativePath);
}

function manifestAssetFiles(manifest) {
  const files = new Set();
  for (const entry of Object.values(manifest)) {
    if (typeof entry?.file === "string") files.add(entry.file);
    for (const field of [entry?.css, entry?.assets]) {
      if (!Array.isArray(field)) continue;
      for (const file of field) {
        if (typeof file === "string") files.add(file);
      }
    }
  }
  return files;
}

export async function publishWorkbenchWeb({ source, target }) {
  const sourceRoot = resolve(source);
  const targetRoot = resolve(target);
  if (sourceRoot === targetRoot || targetRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("The publish target must not be the build input or one of its descendants");
  }

  const requiredFiles = ["index.html", "version.json", ".vite/manifest.json"];
  for (const requiredFile of requiredFiles) {
    if (!await pathExists(join(sourceRoot, requiredFile))) {
      throw new Error(`Missing required build artifact: ${requiredFile}`);
    }
  }

  const [versionContents, indexContents, manifestContents] = await Promise.all([
    readFile(join(sourceRoot, "version.json"), "utf8"),
    readFile(join(sourceRoot, "index.html"), "utf8"),
    readFile(join(sourceRoot, ".vite/manifest.json"), "utf8"),
  ]);
  const release = parseReleaseVersion(versionContents, join(sourceRoot, "version.json"));
  assertBuildIdInIndex(indexContents, release.buildId);
  const manifest = JSON.parse(manifestContents);
  for (const asset of manifestAssetFiles(manifest)) {
    if (asset.startsWith("assets/")) assertHashedAsset(asset);
  }

  await mkdir(targetRoot, { recursive: true });
  const lockPath = join(targetRoot, ".opencraft-publish.lock");
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await lockHandle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Another release publish holds ${lockPath}`);
    }
    throw error;
  }

  let previousBuildId = null;
  let addedAssets = 0;
  let reusedAssets = 0;
  let publicFiles = 0;
  try {
    const previousVersionPath = join(targetRoot, "version.json");
    if (await pathExists(previousVersionPath)) {
      try {
        previousBuildId = parseReleaseVersion(
          await readFile(previousVersionPath, "utf8"),
          previousVersionPath,
        ).buildId;
      } catch {
        previousBuildId = null;
      }
    }

    const releaseFiles = await listFiles(sourceRoot);
    for (const relativePath of releaseFiles) {
      if (
        relativePath === "index.html"
        || relativePath === "version.json"
        || relativePath === ".vite/manifest.json"
        || relativePath.endsWith(".map")
      ) {
        continue;
      }

      const sourcePath = join(sourceRoot, ...relativePath.split("/"));
      const destinationPath = join(targetRoot, ...relativePath.split("/"));
      if (isContentHashedAsset(relativePath)) {
        if (await copyImmutableAsset(sourcePath, destinationPath)) addedAssets += 1;
        else reusedAssets += 1;
        continue;
      }

      // Files copied verbatim from Vite public/ may intentionally live below
      // assets/ without a content hash. They are not manifest-owned, receive a
      // revalidation cache policy, and are replaced atomically before the entry.
      await writeAtomic(destinationPath, await readFile(sourcePath));
      publicFiles += 1;
    }

    const releaseDirectory = join(targetRoot, "releases", release.buildId);
    await writeAtomic(join(releaseDirectory, "manifest.json"), manifestContents);
    await writeAtomic(join(releaseDirectory, "version.json"), versionContents);

    // The old entry remains valid throughout the asset copy. The two mutable
    // pointers are switched only after every file required by the new entry is
    // durable; old hashed assets are never deleted by this command.
    await writeAtomic(join(targetRoot, "index.html"), indexContents);
    await writeAtomic(join(targetRoot, "version.json"), versionContents);
  } finally {
    await lockHandle?.close();
    await rm(lockPath, { force: true });
  }

  return {
    buildId: release.buildId,
    previousBuildId,
    source: sourceRoot,
    target: targetRoot,
    addedAssets,
    reusedAssets,
    publicFiles,
  };
}

function parseArguments(arguments_) {
  const options = {
    source: process.env.OPENCRAFT_WEB_BUILD_ROOT || join(repositoryRoot, "apps/workbench-web/dist"),
    target: process.env.OPENCRAFT_WEB_RELEASE_ROOT || join(repositoryRoot, ".runtime/workbench-web"),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--source" && argument !== "--target") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

const isMain = process.argv[1] != null
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  publishWorkbenchWeb(parseArguments(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
