#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs"]);
const DEFAULT_WEBP_QUALITY = 82;
const DEFAULT_JPEG_QUALITY = 82;
const URL_RE = /(^|["'(\s=])((?:\.\.\/|\.\/|\/(?!\/))[^"'()\s?#]+?\.(?:png|jpe?g))(\?[^"'()\s#]*)?(#[^"'()\s]*)?/gi;

function usage() {
  return "Usage: node scripts/optimize-static-assets.mjs <dist-dir> [more-dist-dirs...]";
}

function normalizePathForLog(filePath, rootDir) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isInsideRoot(candidatePath, rootDir) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function webpPathForImage(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.webp`);
}

async function optimizeOriginalImage(imagePath) {
  const original = await readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  let optimized;

  if (ext === ".png") {
    optimized = await sharp(original, { animated: false })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } else {
    optimized = await sharp(original, { animated: false })
      .jpeg({ quality: DEFAULT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  }

  if (optimized.length >= original.length) {
    return { changed: false, before: original.length, after: original.length };
  }

  const tempPath = `${imagePath}.tmp-${process.pid}`;
  await writeFile(tempPath, optimized);
  await rename(tempPath, imagePath);
  return { changed: true, before: original.length, after: optimized.length };
}

async function writeWebpImage(imagePath, webpPath) {
  await mkdir(path.dirname(webpPath), { recursive: true });
  const webp = await sharp(imagePath, { animated: false })
    .webp({ quality: DEFAULT_WEBP_QUALITY, effort: 5 })
    .toBuffer();
  await writeFile(webpPath, webp);
  return webp.length;
}

function resolveReferencedPath(referencePath, textFilePath, rootDir) {
  const resolved = referencePath.startsWith("/")
    ? path.join(rootDir, referencePath.slice(1))
    : path.resolve(path.dirname(textFilePath), referencePath);
  return path.normalize(resolved);
}

function replaceReferenceExtension(referencePath) {
  return referencePath.replace(/\.(png|jpe?g)$/i, ".webp");
}

function isFunctionArgumentString(text, matchOffset, boundary) {
  if (boundary !== "\"" && boundary !== "'") return false;
  const beforeQuote = text.slice(0, matchOffset);
  return /[A-Za-z_$][\w$]*\(\s*$/.test(beforeQuote);
}

async function rewriteTextFileReferences(textFilePath, rootDir, webpByOriginalPath) {
  const originalText = await readFile(textFilePath, "utf8");
  const ext = path.extname(textFilePath).toLowerCase();
  const isScript = ext === ".js" || ext === ".mjs";
  let replacements = 0;
  const rewritten = originalText.replace(URL_RE, (match, boundary, referencePath, query = "", hash = "", offset) => {
    if (isScript && isFunctionArgumentString(originalText, offset, boundary)) return match;

    const imagePath = resolveReferencedPath(referencePath, textFilePath, rootDir);
    if (!isInsideRoot(imagePath, rootDir)) return match;

    const webpPath = webpByOriginalPath.get(imagePath);
    if (!webpPath || !existsSync(webpPath)) return match;

    replacements += 1;
    return `${boundary}${replaceReferenceExtension(referencePath)}${query}${hash}`;
  });

  if (rewritten !== originalText) {
    await writeFile(textFilePath, rewritten, "utf8");
  }
  return replacements;
}

export async function optimizeStaticAssets(distDir, { log = console.log } = {}) {
  const rootDir = path.resolve(distDir);
  const rootStat = await stat(rootDir).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`asset output directory does not exist: ${distDir}`);
  }

  const files = await walkFiles(rootDir);
  const imageFiles = files.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const textFiles = files.filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));

  const targetSources = new Map();
  for (const imagePath of imageFiles) {
    const webpPath = webpPathForImage(imagePath);
    const sources = targetSources.get(webpPath) ?? [];
    sources.push(imagePath);
    targetSources.set(webpPath, sources);
  }

  const webpByOriginalPath = new Map();
  const skippedCollisions = [];
  let originalsChanged = 0;
  let originalBytesBefore = 0;
  let originalBytesAfter = 0;
  let webpWritten = 0;
  let webpBytes = 0;

  for (const imagePath of imageFiles) {
    const webpPath = webpPathForImage(imagePath);
    const collidingSources = targetSources.get(webpPath) ?? [];
    if (collidingSources.length > 1) {
      skippedCollisions.push(normalizePathForLog(imagePath, rootDir));
      continue;
    }

    const optimized = await optimizeOriginalImage(imagePath);
    originalBytesBefore += optimized.before;
    originalBytesAfter += optimized.after;
    if (optimized.changed) originalsChanged += 1;

    const webpSize = await writeWebpImage(imagePath, webpPath);
    webpByOriginalPath.set(imagePath, webpPath);
    webpWritten += 1;
    webpBytes += webpSize;
  }

  let referenceRewrites = 0;
  for (const textFile of textFiles) {
    referenceRewrites += await rewriteTextFileReferences(textFile, rootDir, webpByOriginalPath);
  }

  const summary = {
    dir: rootDir,
    images: imageFiles.length,
    originalsChanged,
    originalBytesBefore,
    originalBytesAfter,
    webpWritten,
    webpBytes,
    referenceRewrites,
    skippedCollisions,
  };

  log(
    `[asset-optimize] ${normalizePathForLog(rootDir, process.cwd())}: `
    + `images=${summary.images} originalsChanged=${summary.originalsChanged} `
    + `webpWritten=${summary.webpWritten} rewrites=${summary.referenceRewrites}`,
  );
  if (skippedCollisions.length > 0) {
    log(`[asset-optimize] skipped same-basename collisions: ${skippedCollisions.join(", ")}`);
  }
  return summary;
}

const currentModulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : path.resolve(process.cwd(), "scripts/optimize-static-assets.mjs");
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  const dirs = process.argv.slice(2).filter(Boolean);
  if (dirs.length === 0) {
    console.error(usage());
    process.exit(2);
  }

  try {
    for (const dir of dirs) {
      await optimizeStaticAssets(dir);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
