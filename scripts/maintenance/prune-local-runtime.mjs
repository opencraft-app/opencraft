#!/usr/bin/env node
import { appendFile, lstat, mkdir, readFile, readdir, readlink, rm } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export const DAY = 86_400_000;

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

function protectedDirectory(path, repoRoot) {
  const parts = relative(repoRoot, path).split('/');
  return parts.some((part) => /^(?:team-credentials|credentials|private)$/u.test(part));
}

// bb-steward keeps its workbook at <checkout>/.local/steward. It is owner data,
// not runtime output, so the workbook, its contents, and any candidate
// containing it stay.
function protectedSteward(path, repoRoot) {
  const candidate = resolve(path);
  const parts = candidate.split(sep);
  const steward = parts.lastIndexOf("steward");
  if (steward > 0 && parts[steward - 1] === ".local") {
    return true;
  }
  const workbook = join(resolve(repoRoot), ".local", "steward");
  return workbook.startsWith(`${candidate}${sep}`);
}

function isUnder(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function protectedByRoot(path, root) {
  return isUnder(path, root) || isUnder(root, path);
}

function isAuditDirectory(path, repoRoot) {
  return path === join(repoRoot, '.local', 'maintenance');
}

async function treeStats(path) {
  let newest = 0;
  let bytes = 0;
  let sensitive = null;
  let credential = null;
  let protectedDescendant = false;

  async function visit(entryPath) {
    // lstat measures the link itself; neither scanning nor removal follows it.
    const info = await lstat(entryPath);
    newest = Math.max(newest, info.mtimeMs);
    if (/^(?:team-credentials|credentials|private)$/u.test(basename(entryPath))) {
      protectedDescendant = true;
    }
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
    if (kind === "credential" && !credential) {
      credential = { kind, path: entryPath };
    }
  }

  await visit(path);
  return { newest, bytes, sensitive, credential, protectedDescendant };
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
    credential: tree.credential,
    protectedDescendant: tree.protectedDescendant,
    ...proc,
  };
}

function eligibleForRemoval(candidate, repoRoot, protectedRoots) {
  return (
    !candidate.unknown &&
    candidate.refs.length === 0 &&
    !candidate.credential &&
    !protectedDirectory(candidate.path, repoRoot) &&
    !candidate.protectedDescendant &&
    !protectedSteward(candidate.path, repoRoot) &&
    !protectedRoots.some((root) => protectedByRoot(candidate.path, root))
  );
}

function retentionReasons(candidate, repoRoot, protectedRoots = []) {
  const reasons = [];
  if (candidate.unknown) {
    reasons.push(`reason=${candidate.reason}`);
  }
  if (candidate.refs.length) {
    const refs = candidate.refs.map((ref) => `${ref.pid}:${ref.slot}`).join(",");
    reasons.push(`refs=${refs}`);
  }
  if (candidate.credential) {
    reasons.push(`reason=credential:${relative(repoRoot, candidate.credential.path)}`);
  } else if (candidate.sensitive) {
    const { kind, path } = candidate.sensitive;
    reasons.push(`reason=${kind}:${relative(repoRoot, path)}`);
  }
  if (protectedDirectory(candidate.path, repoRoot)) {
    reasons.push("reason=protected-directory");
  }
  if (candidate.protectedDescendant) {
    reasons.push("reason=protected-descendant");
  }
  if (protectedSteward(candidate.path, repoRoot)) {
    reasons.push("reason=protected-steward");
  }
  if (protectedRoots.some((root) => protectedByRoot(candidate.path, root))) {
    reasons.push("reason=operator-protected");
  }
  return reasons;
}

function reportCandidate(candidate, status, repoRoot, report, protectedRoots = []) {
  report(
    [
      status,
      `${Math.round(candidate.ageDays * 10) / 10}d`,
      `${Math.round(candidate.size / 1_048_576)}MiB`,
      relative(repoRoot, candidate.path),
      ...retentionReasons(candidate, repoRoot, protectedRoots),
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
      policy: "unreferenced",
    })}\n`,
  );
}

export async function runRetention({
  repoRoot = defaultRepoRoot,
  roots = [join(repoRoot, ".local"), join(repoRoot, ".runtime")],
  procRoot = "/proc",
  now = Date.now(),
  apply = false,
  protectedRoots = [],
  report = console.log,
} = {}) {
  const candidates = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const path = join(root, entry.name);
        if (!isAuditDirectory(path, repoRoot)) candidates.push(await inspect(path, now, procRoot));
      }
    }
  }

  const resolvedProtectedRoots = protectedRoots.map((root) => resolve(root));
  const eligible = candidates.filter((candidate) => eligibleForRemoval(candidate, repoRoot, resolvedProtectedRoots));
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
    reportCandidate(candidate, status, repoRoot, report, resolvedProtectedRoots);
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
  const protectedRoots = process.env.OPENCRAFT_LOCAL_RUNTIME_PROTECTED_ROOTS?.split(",")
    .filter(Boolean)
    .map((root) => resolve(root));
  await runRetention({
    roots,
    protectedRoots,
    procRoot: process.env.OPENCRAFT_LOCAL_RUNTIME_PROC_ROOT || "/proc",
    apply: process.argv.includes("--apply"),
    now: nowArgument ? new Date(nowArgument.slice(6)).getTime() : Date.now(),
  });
}

if (import.meta.main) {
  await main();
}
