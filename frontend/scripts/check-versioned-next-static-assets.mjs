import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const outRoot = join(process.cwd(), "out");
const releaseId = process.env.NEXT_PUBLIC_RELEASE_ID || process.env.NEXT_STATIC_RELEASE_ID || "";
const assetPrefix = process.env.NEXT_PUBLIC_ASSET_PREFIX || "";
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".mjs", ".svg", ".txt", ".webmanifest", ".xml"]);

function extension(path) {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function walkTextFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(path));
    } else if (entry.isFile() && textExtensions.has(extension(path))) {
      files.push(path);
    }
  }
  return files;
}

if (process.env.NEXT_VERSION_STATIC_ASSETS !== "1") {
  console.log("[check-versioned-next-static-assets] skipped by NEXT_VERSION_STATIC_ASSETS!=1");
  process.exit(0);
}

if (!releaseId) throw new Error("NEXT_PUBLIC_RELEASE_ID or NEXT_STATIC_RELEASE_ID is required");
if (assetPrefix !== `/__releases/${releaseId}`) {
  throw new Error(`NEXT_PUBLIC_ASSET_PREFIX must equal /__releases/${releaseId}, got ${assetPrefix || "<empty>"}`);
}
if (!existsSync(outRoot) || !statSync(outRoot).isDirectory()) {
  throw new Error(`missing Next static output directory: ${outRoot}`);
}

const releaseStaticRoot = join(outRoot, "__releases", releaseId, "_next", "static");
if (!existsSync(releaseStaticRoot) || !statSync(releaseStaticRoot).isDirectory()) {
  throw new Error(`missing versioned Next static assets: ${releaseStaticRoot}`);
}
if (existsSync(join(outRoot, "_next", "static"))) {
  throw new Error("unversioned out/_next/static still exists");
}

const failures = [];
const referenced = new Set();
const escapedAssetPrefix = assetPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unversionedReferencePatterns = [
  /(?:src|href)=["']\/_next\/static\//,
  /url\(["']?\/_next\/static\//,
  /HL\["\/_next\/static\//,
];
const versionedReferencePatterns = [
  new RegExp(`(?:src|href)=["'](${escapedAssetPrefix}/_next/static/[^"']+)`, "g"),
  new RegExp(`url\\(["']?(${escapedAssetPrefix}/_next/static/[^"')]+)`, "g"),
  new RegExp(`HL\\["(${escapedAssetPrefix}/_next/static/[^"']+)`, "g"),
];

function outputPathForReference(ref) {
  const pathWithoutQuery = ref.split(/[?#]/, 1)[0];
  let decoded = pathWithoutQuery;
  try {
    decoded = decodeURIComponent(pathWithoutQuery);
  } catch {
    // Keep the raw path if it is not valid URI-encoded text.
  }
  return join(outRoot, decoded.replace(/^\/+/, ""));
}

for (const file of walkTextFiles(outRoot)) {
  const text = readFileSync(file, "utf8");
  if (unversionedReferencePatterns.some((pattern) => pattern.test(text))) {
    failures.push(`${file}: contains unversioned /_next/static/ reference`);
  }

  for (const pattern of versionedReferencePatterns) {
    for (const match of text.matchAll(pattern)) {
      referenced.add(match[1].replace(/\\+$/, ""));
    }
  }
}

for (const ref of referenced) {
  const absolute = outputPathForReference(ref);
  if (!existsSync(absolute)) {
    failures.push(`missing referenced static asset: ${ref}`);
  }
}

if (failures.length > 0) {
  console.error("[check-versioned-next-static-assets] checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[check-versioned-next-static-assets] checked ${referenced.size} versioned static references`);
