#!/usr/bin/env node
import { appendFile, lstat, mkdir, readFile, readdir, readlink, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export const DAY = 86_400_000;
export const RETENTION_DAYS = 7;

const defaultRepoRoot = resolve(import.meta.dirname, "../..");
const processSlots = ["cwd", "root", "exe", "maps", "fd"];

export function dateStamped(name) {
  return /(?:^|[-_])20\d{6}$/.test(name);
}

function sensitiveFileKind(name) {
  const lowerName = name.toLowerCase();
  if (/^(?:\.env(?:\..*)?|.*\.(?:pem|key)|.*(?:credential|token).*)$/.test(lowerName)) {
    return "credential";
  }
  if (/\.(?:db|sqlite.*)$/.test(lowerName) || /-(?:wal|shm)$/.test(lowerName)) {
    return "database";
  }
  return null;
}

async function treeStats(path) {
  let newest = 0;
  let bytes = 0;
  let sensitive = null;

  async function visit(entryPath) {
    // lstat measures the link itself; neither scanning nor removal follows it.
    const info = await lstat(entryPath);
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) {
      for (const entry of await readdir(entryPath, { withFileTypes: true })) {
        await visit(join(entryPath, entry.name));
      }
      return;
    }

    bytes += info.size;
    const kind = sensitiveFileKind(basename(entryPath));
    if (kind && !sensitive) {
      sensitive = { kind, path: entryPath };
    }
  }

  await visit(path);
  return { newest, bytes, sensitive };
}

function referencesDirectory(target, path) {
  return target === path || target.startsWith(`${path}/`);
}

async function slotReferences(path, processPath, slot) {
  const slotPath = join(processPath, slot);
  if (slot === "maps") {
    const maps = await readFile(slotPath, "utf8");
    return maps.includes(path) ? [path] : [];
  }

  const links = slot === "fd" ? await readdir(slotPath) : [""];
  const targets = [];
  for (const link of links) {
    let target;
    try {
      target = await readlink(join(slotPath, link));
    } catch (error) {
      // Descriptors can close after enumeration, including readdir's own fd.
      if (slot === "fd" && (error.code === "ENOENT" || error.code === "ESRCH")) {
        continue;
      }
      throw error;
    }
    if (referencesDirectory(target, path)) {
      targets.push(target);
    }
  }
  return targets;
}

export async function processReferences(path, procRoot = "/proc") {
  let entries;
  try {
    entries = await readdir(procRoot, { withFileTypes: true });
  } catch (error) {
    return {
      refs: [],
      unknown: true,
      reason: `proc:${error.code ?? "read-failed"}`,
    };
  }

  const refs = [];
  let unknown = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const processPath = join(procRoot, entry.name);
    for (const slot of processSlots) {
      try {
        const targets = await slotReferences(path, processPath, slot);
        for (const target of targets) {
          refs.push({ pid: Number(entry.name), slot, target });
        }
      } catch (error) {
        // Kernel threads and zombies can lack slots even while their PID exists.
        // Missing entries are absent references; unreadable entries are unknown.
        if (error.code !== "ENOENT" && error.code !== "ESRCH") {
          unknown = true;
        }
      }
    }
  }
  return { refs, unknown, reason: unknown ? "proc-read-unknown" : undefined };
}

export async function inspect(path, at = Date.now(), procRoot = "/proc") {
  const tree = await treeStats(path);
  const proc = await processReferences(path, procRoot);
  return {
    path,
    mtime: new Date(tree.newest).toISOString(),
    ageDays: (at - tree.newest) / DAY,
    size: tree.bytes,
    sensitive: tree.sensitive,
    ...proc,
  };
}

function eligibleForRemoval(candidate) {
  return (
    candidate.ageDays >= RETENTION_DAYS &&
    !candidate.unknown &&
    candidate.refs.length === 0 &&
    !candidate.sensitive
  );
}

function retentionReasons(candidate, repoRoot) {
  const reasons = [];
  if (candidate.unknown) {
    reasons.push(`reason=${candidate.reason}`);
  }
  if (candidate.refs.length) {
    const refs = candidate.refs.map((ref) => `${ref.pid}:${ref.slot}`).join(",");
    reasons.push(`refs=${refs}`);
  }
  if (candidate.sensitive) {
    const { kind, path } = candidate.sensitive;
    reasons.push(`reason=${kind}:${relative(repoRoot, path)}`);
  }
  return reasons;
}

function reportCandidate(candidate, status, repoRoot, report) {
  report(
    [
      status,
      `${Math.round(candidate.ageDays * 10) / 10}d`,
      `${Math.round(candidate.size / 1_048_576)}MiB`,
      relative(repoRoot, candidate.path),
      ...retentionReasons(candidate, repoRoot),
    ].join("\t"),
  );
}

async function removeCandidate(candidate, repoRoot) {
  const logDirectory = join(repoRoot, ".local/maintenance");
  const logPath = join(logDirectory, "local-runtime-retention.jsonl");
  await mkdir(logDirectory, { recursive: true });
  await rm(candidate.path, { recursive: true, force: true });
  await appendFile(
    logPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      path: relative(repoRoot, candidate.path),
      bytes: candidate.size,
      retentionDays: RETENTION_DAYS,
    })}\n`,
  );
}

export async function runRetention({
  repoRoot = defaultRepoRoot,
  roots = [join(repoRoot, ".local"), join(repoRoot, ".runtime")],
  procRoot = "/proc",
  now = Date.now(),
  apply = false,
  report = console.log,
} = {}) {
  const candidates = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && dateStamped(entry.name)) {
        candidates.push(await inspect(join(root, entry.name), now, procRoot));
      }
    }
  }

  const eligible = candidates.filter(eligibleForRemoval);
  const bytes = eligible.reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of candidates) {
    let status = "kept";
    if (eligible.includes(candidate)) {
      status = "would-remove";
      if (apply) {
        await removeCandidate(candidate, repoRoot);
        status = "removed";
      }
    }
    reportCandidate(candidate, status, repoRoot, report);
  }
  report(
    [
      "summary",
      `candidates=${candidates.length}`,
      `eligible=${eligible.length}`,
      `reclaimable=${Math.round(bytes / 1_048_576)}MiB`,
      `mode=${apply ? "apply" : "dry-run"}`,
    ].join("\t"),
  );
  return { candidates, eligible, bytes };
}

async function main() {
  const nowArgument = process.argv.find((arg) => arg.startsWith("--now="));
  const roots = process.env.OPENCRAFT_LOCAL_RUNTIME_ROOTS?.split(",")
    .filter(Boolean)
    .map((root) => resolve(root));
  await runRetention({
    roots,
    apply: process.argv.includes("--apply"),
    now: nowArgument ? new Date(nowArgument.slice(6)).getTime() : Date.now(),
  });
}

if (import.meta.main) {
  await main();
}
