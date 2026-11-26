#!/usr/bin/env node
/**
 * Two-layer companion updater: stages and verifies immutable release archives,
 * snapshots SQLite databases (main + WAL + SHM) before trial activation, and
 * atomically restores both runtime symlink and database state on trial failure.
 */
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  symlink,
  lstat,
  realpath,
  copyFile,
  chmod,
  readdir,
} from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute, delimiter } from "node:path";
import { homedir } from "node:os";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { machineLaunchAgentLabel } from "./service.mjs";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SQLITE_FILE_PATTERN = /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/iu;

export function verifyArchive(bytes, digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest) || createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("Update archive checksum mismatch");
  }
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  let offset = 0;
  let paxPath = null;
  const assertSafeEntry = (name) => {
    if (!name || name.includes("\\") || isAbsolute(name) || name.split("/").includes("..")) {
      throw new Error("Unsafe update archive path");
    }
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/su, "");
    const sum = Number.parseInt(text(148, 156).trim(), 8);
    const actual = header.reduce((acc, byte, idx) => acc + (idx >= 148 && idx < 156 ? 32 : byte), 0);
    const size = Number.parseInt(text(124, 136).trim() || "0", 8);
    const type = text(156, 157);
    if (sum !== actual || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new Error("Invalid update archive header");
    }
    let name = text(0, 100);
    const prefix = text(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    assertSafeEntry(name);
    if (type === "x" || type === "g") {
      const metadata = tar.subarray(offset + 512, offset + 512 + size);
      let position = 0;
      while (position < metadata.length) {
        const space = metadata.indexOf(32, position);
        if (space < position) throw new Error("Invalid archive metadata");
        const length = Number(metadata.subarray(position, space).toString());
        if (!Number.isSafeInteger(length) || length <= space - position + 1 || position + length > metadata.length) {
          throw new Error("Invalid archive metadata");
        }
        const item = metadata.subarray(space + 1, position + length - 1).toString();
        if (item.startsWith("path=")) {
          paxPath = item.slice(5);
          assertSafeEntry(paxPath);
        }
        if (item.startsWith("linkpath=")) throw new Error("Archive links are not supported");
        position += length;
      }
    } else {
      if (!["", "0", "5"].includes(type)) throw new Error("Archive links or special files are not supported");
      if (paxPath) {
        assertSafeEntry(paxPath);
        paxPath = null;
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (offset === 0) throw new Error("Empty update archive");
}

export function validateOrigin(origin) {
  const url = new URL(origin);
  if (
    url.origin !== origin
    || url.username
    || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  ) {
    throw new Error("HTTPS update origin is required");
  }
}

export function validateConnection(config) {
  if (
    !config
    || config.schemaVersion !== 1
    || !/^[-a-f0-9]{36}$/u.test(config.id)
    || !/^[-a-f0-9]{36}$/u.test(config.hubId)
    || !/^[A-Za-z0-9_-]{43}$/u.test(config.credential)
    || config.phase !== "enrolled"
  ) {
    throw new Error("An enrolled machine is required");
  }
  validateOrigin(config.origin);
}

export function download(config, path, limit = MAX_ARCHIVE_BYTES) {
  try {
    validateOrigin(config.origin);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((done, fail) => {
    const req = (config.origin.startsWith("https:") ? httpsRequest : httpRequest)(
      config.origin + path,
      { ca: config.ca, headers: { authorization: `Bearer ${config.credential}` }, timeout: 120_000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Machine update unavailable (${res.statusCode}); check enrollment or retry later`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit) {
            res.destroy(new Error("Update response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("Update download interrupted")));
        res.on("end", () => done(Buffer.concat(chunks)));
      },
    );
    req.on("error", () => fail(new Error("Cannot reach the machine update server")));
    req.on("timeout", () => req.destroy(new Error("Update request timed out")));
    req.end();
  });
}

const run = (command, args, cwd) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        OPENCRAFT_MACHINE_BOOTSTRAP: "",
        OPENCRAFT_MACHINE_KEY: "",
      },
    });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error("Update preparation or startup failed"))));
  });

async function atomicJson(targetPath, value) {
  const temp = `${targetPath}.new`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, targetPath);
}

async function optional(targetPath) {
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

async function collectSqliteFiles(rootDir, currentDir = rootDir, result = []) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectSqliteFiles(rootDir, fullPath, result);
    } else if (entry.isFile() && SQLITE_FILE_PATTERN.test(entry.name)) {
      result.push(relative(rootDir, fullPath));
    }
  }
  return result;
}

/**
 * Snapshots SQLite files (main, WAL, SHM) once after the old runtime stops and
 * never overwrites an existing snapshot on retry so failed trial migrations can
 * roll back cleanly without down-migrations.
 */
export async function snapshotSqliteDatabases(state) {
  const snapshotRoot = join(state, ".sqlite-snapshot");
  const manifestPath = join(snapshotRoot, "manifest.json");
  if (await optional(manifestPath)) return;
  const dataRoot = join(state, "data");
  const files = await collectSqliteFiles(dataRoot);
  const staging = `${snapshotRoot}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const relPath of files) {
      const dest = join(staging, "files", relPath);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await copyFile(join(dataRoot, relPath), dest);
      await chmod(dest, 0o600);
    }
    await writeFile(join(staging, "manifest.json"), JSON.stringify({ schemaVersion: 1, files }), { mode: 0o600 });
    await rm(snapshotRoot, { recursive: true, force: true });
    await rename(staging, snapshotRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function restoreSqliteDatabases(state) {
  const snapshotRoot = join(state, ".sqlite-snapshot");
  const manifestRaw = await optional(join(snapshotRoot, "manifest.json"));
  if (!manifestRaw) return;
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Invalid SQLite snapshot manifest");
  }
  const dataRoot = join(state, "data");
  const currentFiles = await collectSqliteFiles(dataRoot);
  const snapshotSet = new Set(manifest.files);
  for (const relPath of currentFiles) {
    if (!snapshotSet.has(relPath)) {
      await rm(join(dataRoot, relPath), { force: true });
    }
  }
  for (const relPath of manifest.files) {
    if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) {
      throw new Error("Unsafe SQLite snapshot entry");
    }
    const dest = join(dataRoot, relPath);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const temp = `${dest}.${process.pid}.restore`;
    await copyFile(join(snapshotRoot, "files", relPath), temp);
    await chmod(temp, 0o600);
    await rename(temp, dest);
  }
}

const socketControl = (state, method) =>
  new Promise((done, fail) => {
    const req = httpRequest({ socketPath: join(state, "control.sock"), path: "/status", method, timeout: 60_000 }, (res) => {
      res.resume();
      res.on("end", done);
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("Machine shutdown timed out")));
    req.end();
  });

const capture = (command, args) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.resume();
    child.on("error", fail);
    child.on("exit", () => done(out));
  });

function serviceDefinitionPaths(id) {
  return {
    systemdUnit: join(homedir(), `.config/systemd/user/opencraft-machine-${id}.service`),
    launchdPlist: join(homedir(), `Library/LaunchAgents/${machineLaunchAgentLabel(id)}.plist`),
  };
}

export async function stop(state, unit, commands = { run, capture }) {
  const config = JSON.parse(await readFile(join(state, "connection.json"), "utf8"));
  if (unit && (await optional(unit))) {
    if (unit.endsWith(".plist")) {
      const domain = `gui/${process.getuid?.() ?? 0}`;
      await commands.run("launchctl", ["bootout", domain, unit], state).catch(() => {});
    } else {
      const name = `opencraft-machine-${config.id}.service`;
      const query = async () => {
        const out = await commands.capture("systemctl", ["--user", "show", name, "--property=LoadState", "--property=ActiveState"]);
        return Object.fromEntries(
          out
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split("=")),
        );
      };
      const status = await query();
      if (["inactive", "failed"].includes(status.ActiveState)) return;
      if (!["active", "activating", "deactivating", "reloading"].includes(status.ActiveState)) {
        throw new Error("Machine service state is unknown; update was not replayed");
      }
      await commands.run("systemctl", ["--user", "stop", name], state);
      if (!["inactive", "failed"].includes((await query()).ActiveState)) {
        throw new Error("Machine service did not stop");
      }
      return;
    }
  }
  try {
    await socketControl(state, "DELETE");
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
  }
}

async function linkRuntime(state, target) {
  const runtime = join(state, "runtime");
  const temp = `${runtime}.next`;
  await rm(temp, { force: true });
  await symlink(target, temp);
  await rename(temp, runtime);
}

async function start(state) {
  await run(
    process.execPath,
    ["--import", join(state, "runtime/node_modules/tsx/dist/loader.mjs"), join(state, "runtime/scripts/personal-machine/daemon.ts"), "--state", state, "--install"],
    join(state, "runtime"),
  );
}

async function restoreFile(targetPath, encoded) {
  if (encoded === null || encoded === undefined) {
    await rm(targetPath, { force: true });
  } else {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(encoded, "base64"), { mode: 0o600 });
  }
}

function assertInsideState(state, candidatePath) {
  const rel = relative(state, candidatePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Update path is outside this machine");
  }
}

function resolveManagedUnitPath(config) {
  const paths = serviceDefinitionPaths(config.id);
  return process.platform === "darwin" ? paths.launchdPlist : paths.systemdUnit;
}

export async function activate(state, candidate, version, operations = { stop, start }) {
  state = await realpath(state);
  candidate = await realpath(candidate);
  const config = JSON.parse(await readFile(join(state, "connection.json"), "utf8"));
  const unit = resolveManagedUnitPath(config);
  const runtime = join(state, "runtime");
  const current = await realpath(runtime);
  const stat = await lstat(runtime);
  assertInsideState(state, current);
  assertInsideState(state, candidate);
  if (current === candidate) throw new Error("No different runtime is available");
  const record = {
    schemaVersion: 1,
    previous: stat.isSymbolicLink() ? current : join(state, `releases/legacy-${randomUUID()}`),
    candidate,
    version,
    unit,
    unitBytes: (await optional(unit))?.toString("base64") ?? null,
    wrapperBytes: (await optional(join(state, "opencraft-machine")))?.toString("base64") ?? null,
    launcherBytes: (await optional(join(state, "launcher.mjs")))?.toString("base64") ?? null,
  };
  await atomicJson(join(state, "update-pending.json"), record);
  await operations.stop(state, unit);
  await snapshotSqliteDatabases(state);
  if (!stat.isSymbolicLink()) {
    await mkdir(dirname(record.previous), { recursive: true, mode: 0o700 });
    await rename(runtime, record.previous);
  }
  await linkRuntime(state, candidate);
  try {
    await operations.start(state);
    await atomicJson(join(state, "update-version.json"), { schemaVersion: 1, version, previous: record.previous });
    await rm(join(state, "update-pending.json"), { force: true });
    await rm(join(state, ".sqlite-snapshot"), { recursive: true, force: true });
  } catch (trialError) {
    try {
      await operations.stop(state, unit);
      await restoreSqliteDatabases(state);
      await linkRuntime(state, record.previous);
      await restoreFile(unit, record.unitBytes);
      await restoreFile(join(state, "opencraft-machine"), record.wrapperBytes);
      await restoreFile(join(state, "launcher.mjs"), record.launcherBytes);
      if (record.wrapperBytes) await chmod(join(state, "opencraft-machine"), 0o700);
      await operations.start(state);
      await rm(join(state, "update-pending.json"), { force: true });
      await rm(join(state, ".sqlite-snapshot"), { recursive: true, force: true });
    } catch (rollbackError) {
      throw new AggregateError([trialError, rollbackError], "Machine update trial and automatic rollback failed");
    }
    throw trialError;
  }
}

export async function recover(state, operations = { stop, start }, restart = true) {
  state = await realpath(state);
  const record = JSON.parse(await readFile(join(state, "update-pending.json"), "utf8"));
  const config = JSON.parse(await readFile(join(state, "connection.json"), "utf8"));
  const expectedUnit = resolveManagedUnitPath(config);
  if (record.schemaVersion !== 1 || record.unit !== expectedUnit) {
    throw new Error("Invalid recovery record");
  }
  for (const item of [record.previous, record.candidate]) {
    assertInsideState(state, item);
  }
  await operations.stop(state, expectedUnit);
  await restoreSqliteDatabases(state);
  try {
    await lstat(record.previous);
    await linkRuntime(state, record.previous);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if ((await lstat(join(state, "runtime"))).isSymbolicLink()) {
      throw new Error("Previous runtime is unavailable");
    }
  }
  await restoreFile(expectedUnit, record.unitBytes);
  await restoreFile(join(state, "opencraft-machine"), record.wrapperBytes);
  await restoreFile(join(state, "launcher.mjs"), record.launcherBytes);
  if (record.wrapperBytes) await chmod(join(state, "opencraft-machine"), 0o700);
  if (restart) {
    await operations.start(state);
    await rm(join(state, ".sqlite-snapshot"), { recursive: true, force: true });
  }
  await rm(join(state, "update-pending.json"), { force: true });
  console.log(
    restart
      ? "Interrupted update recovered; previous machine runtime started."
      : "Interrupted update restored; preparing the new runtime.",
  );
}

export async function acquireUpdateLock(state, recovery = false) {
  const lock = join(state, "update.lock");
  const staging = join(state, `.update-lock-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  await writeFile(join(staging, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  try {
    try {
      await rename(staging, lock);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code) || !recovery) {
        throw new Error("Another update holds the lock; use --recover only after an interrupted update.");
      }
      const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid update lock owner");
      try {
        process.kill(owner.pid, 0);
        throw new Error("The update process is still running; recovery did not change it.");
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") throw probeError;
      }
      await rm(lock, { recursive: true });
      await rename(staging, lock);
    }
    return lock;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function assertCompatibleNodeRuntime(nodeVersion, requiredNodeVersion) {
  if (requiredNodeVersion !== undefined) {
    if (nodeVersion !== requiredNodeVersion) {
      throw new Error(`This update requires the installed private Node ${requiredNodeVersion} runtime`);
    }
    return;
  }
  const [majorText, minorText] = String(nodeVersion ?? "").split(".");
  const major = Number.parseInt(majorText ?? "0", 10);
  const minor = Number.parseInt(minorText ?? "0", 10);
  if (!Number.isInteger(major) || major < 22 || (major === 22 && minor < 16)) {
    throw new Error("This update requires Node.js >= 22.16");
  }
}

export async function runUpdate(state, action = "--update", operations = {}) {
  const runtimeOps = { stop: operations.stop ?? stop, start: operations.start ?? start };
  state = await realpath(resolve(state));
  const config = JSON.parse(await readFile(join(state, "connection.json"), "utf8"));
  validateConnection(config);
  const lock = await acquireUpdateLock(state, action === "--recover");
  try {
    if (action === "--recover") {
      await recover(state, runtimeOps);
      return;
    }
    if (await optional(join(state, "update-pending.json"))) {
      if (action === "--update") await recover(state, runtimeOps, false);
      else throw new Error("An interrupted update needs recovery; run --recover before another update.");
    }
    if (action === "--rollback") {
      const previous = JSON.parse(await readFile(join(state, "update-version.json"), "utf8")).previous;
      const version = (await readFile(join(previous, ".machine-version"), "utf8").catch(() => "legacy")).trim();
      await activate(state, previous, version, runtimeOps);
      console.log("Previous machine runtime activated.");
      return;
    }
    const metadata = JSON.parse((await download(config, `/__opencraft_machines/bootstrap?update=1&id=${config.id}`, 16_384)).toString());
    if (
      metadata.schemaVersion !== 1
      || metadata.id !== config.id
      || metadata.hubId !== config.hubId
      || metadata.origin !== config.origin
      || !/^[a-f0-9]{64}$/u.test(metadata.digest)
    ) {
      throw new Error("Update identity mismatch");
    }
    const version = (await optional(join(state, "runtime/.machine-version")))?.toString().trim();
    if (version === metadata.digest) {
      console.log("Machine runtime is up to date.");
      return;
    }
    if (action === "--check-update") {
      console.log(`A machine runtime update is available: ${metadata.digest.slice(0, 12)}`);
      return;
    }
    assertCompatibleNodeRuntime(operations.nodeVersion ?? process.versions.node, operations.requiredNodeVersion);
    await mkdir(join(state, "releases"), { recursive: true, mode: 0o700 });
    const candidate = join(state, "releases", metadata.digest);
    if (!(await optional(join(candidate, ".machine-version")))) {
      const bytes = await download(config, `/__opencraft_machines/source.tgz?update=1&id=${config.id}`);
      verifyArchive(bytes, metadata.digest);
      const staging = join(state, "releases", `.candidate-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await writeFile(join(staging, "source.tgz"), bytes, { mode: 0o600 });
        await run("tar", ["-xzf", "source.tgz"], staging);
        await rm(join(staging, "source.tgz"));
        console.log("Preparing machine runtime; the current runtime remains active.");
        const prepareScript = join(staging, "scripts/personal-machine/prepare.mjs");
        if (await optional(prepareScript)) {
          await run(process.execPath, [prepareScript], staging);
        } else {
          const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
          await run(npmCmd, ["ci", "--no-audit", "--no-fund"], staging);
          await run(npmCmd, ["run", "prepare:dsh-runtime"], staging);
          await run(npmCmd, ["run", "build:preview-bridge"], staging);
        }
        await writeFile(join(staging, ".machine-version"), `${metadata.digest}\n`, { mode: 0o600 });
        await rename(staging, candidate);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    await activate(state, candidate, metadata.digest, runtimeOps);
    console.log("Machine runtime updated and connected. Previous runtime retained for rollback.");
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--state");
  if (idx < 0 || !args[idx + 1]) throw new Error("--state is required");
  const action = ["--check-update", "--rollback", "--recover"].find((flag) => args.includes(flag)) ?? "--update";
  await runUpdate(args[idx + 1], action);
}
