import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const outRoot = join(process.cwd(), "out");
const nextStaticRoot = join(outRoot, "_next", "static");
const releasesRoot = join(outRoot, "__releases");
const releaseTtlHours = Number(process.env.NEXT_STATIC_RELEASE_TTL_HOURS || "48");
const timestampPattern = /^(\d{14})-/;

function pad(value) {
  return String(value).padStart(2, "0");
}

function utcTimestamp(date = new Date()) {
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function shortSha() {
  const envSha =
    process.env.NEXT_PUBLIC_RELEASE_SHA ||
    process.env.CI_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.BK_CI_GIT_REPO_HEAD_COMMIT_ID ||
    "";
  if (envSha) return envSha.slice(0, 12);

  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function releaseId() {
  const explicit = process.env.NEXT_PUBLIC_RELEASE_ID || process.env.NEXT_STATIC_RELEASE_ID;
  if (explicit) return explicit;
  return `${utcTimestamp()}-${shortSha()}`;
}

function releaseNowMs() {
  const explicit = process.env.NEXT_STATIC_RELEASE_NOW || "";
  if (!explicit) return Date.now();

  const parsed = Date.parse(explicit);
  if (Number.isNaN(parsed)) {
    throw new Error(`NEXT_STATIC_RELEASE_NOW is not a valid date: ${explicit}`);
  }
  return parsed;
}

function parseUtcTimestamp(value) {
  const match = value.match(timestampPattern);
  if (!match) return null;
  const raw = match[1];
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isNaN(time) ? null : time;
}

function pruneExpiredReleases(currentReleaseId) {
  if (!existsSync(releasesRoot)) return 0;
  const cutoff = releaseNowMs() - releaseTtlHours * 60 * 60 * 1000;
  let removed = 0;

  for (const entry of readdirSync(releasesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentReleaseId) continue;

    const createdAt = parseUtcTimestamp(entry.name);
    if (createdAt === null) {
      console.warn(`[version-next-static-assets] kept ${entry.name}: cannot parse release timestamp`);
      continue;
    }

    if (createdAt < cutoff) {
      rmSync(join(releasesRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }

  return removed;
}

function ensureAssetPrefix(currentReleaseId) {
  const expected = `/__releases/${currentReleaseId}`;
  const configured = process.env.NEXT_PUBLIC_ASSET_PREFIX || "";
  if (configured !== expected) {
    throw new Error(
      `NEXT_PUBLIC_ASSET_PREFIX must match release id: expected ${expected}, got ${configured || "<empty>"}`,
    );
  }
}

const currentReleaseId = releaseId();
if (process.env.NEXT_VERSION_STATIC_ASSETS !== "1") {
  console.log("[version-next-static-assets] skipped by NEXT_VERSION_STATIC_ASSETS!=1");
  process.exit(0);
}

ensureAssetPrefix(currentReleaseId);

if (!existsSync(outRoot) || !statSync(outRoot).isDirectory()) {
  throw new Error(`missing Next static output directory: ${outRoot}`);
}
if (!existsSync(nextStaticRoot) || !statSync(nextStaticRoot).isDirectory()) {
  throw new Error(`missing Next static assets directory: ${nextStaticRoot}`);
}

const releaseStaticRoot = join(releasesRoot, currentReleaseId, "_next", "static");
rmSync(releaseStaticRoot, { recursive: true, force: true });
mkdirSync(join(releaseStaticRoot, ".."), { recursive: true });
renameSync(nextStaticRoot, releaseStaticRoot);

const emptyNextDir = join(outRoot, "_next");
try {
  if (existsSync(emptyNextDir) && readdirSync(emptyNextDir).length === 0) rmSync(emptyNextDir, { recursive: true, force: true });
} catch {
  // Keep the directory if another Next output file appears in future versions.
}

const removed = pruneExpiredReleases(currentReleaseId);
console.log(
  `[version-next-static-assets] moved _next/static to __releases/${basename(currentReleaseId)}/_next/static; removed ${removed} expired releases`,
);
