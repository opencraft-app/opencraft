#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  statfsSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), "..");
const gib = 1024 ** 3;
const unescapeMount = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function buildPaths(root, uid = process.getuid()) {
  const cache = join(root, "cache", "users", String(uid));
  return {
    OPENCRAFT_BUILD_ROOT: root,
    TMPDIR: join(root, "tmp", String(uid)),
    TMP: join(root, "tmp", String(uid)),
    TEMP: join(root, "tmp", String(uid)),
    npm_config_cache: join(cache, "npm"),
    NPM_CONFIG_CACHE: join(cache, "npm"),
    ELECTRON_CACHE: join(cache, "electron"),
    ELECTRON_BUILDER_CACHE: join(cache, "electron-builder"),
    XDG_CACHE_HOME: join(cache, "xdg"),
    CCACHE_DIR: join(cache, "ccache"),
    GIT_CACHE_PATH: join(cache, "git"),
  };
}

export function validateBuildVolume(
  root,
  { mountInfo = readFileSync("/proc/self/mountinfo", "utf8"), metadata, device, parentDevice } = {},
) {
  if (!isAbsolute(root) || root === "/") throw Error("OPENCRAFT_BUILD_ROOT must be an absolute dedicated mount");
  const entry = mountInfo
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => unescapeMount(fields[4] ?? "") === root);
  if (!entry || !entry[5]?.split(",").includes("rw") || device === parentDevice)
    throw Error("Build volume is not mounted read/write; refusing to use the system disk");
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.purpose !== "opencraft-build" ||
    !/^[a-f0-9-]{36}$/.test(metadata.filesystemUuid ?? "")
  )
    throw Error("Build volume identity is missing or invalid");
  return metadata;
}

function checkedVolume() {
  const selected = process.env.OPENCRAFT_BUILD_ROOT;
  if (!selected) throw Error("Set OPENCRAFT_BUILD_ROOT to the dedicated build volume");
  const root = realpathSync(selected);
  const metadata = JSON.parse(readFileSync(join(root, ".opencraft-build-volume.json"), "utf8"));
  validateBuildVolume(root, { metadata, device: statSync(root).dev, parentDevice: statSync(dirname(root)).dev });
  const free = statfsSync(root);
  return { root, metadata, availableGiB: Math.floor((free.bavail * free.bsize) / gib) };
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "safe.directory=" + cwd, "-C", cwd, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw Error("Git check failed: " + args[0]);
  return result.stdout.trim();
}

function requireWorktree(root) {
  const cwd = realpathSync(process.cwd());
  const parent = join(root, "worktrees") + "/";
  if (!cwd.startsWith(parent))
    throw Error("Run this build inside a worktree on the build volume; use opencraft-build worktree first");
  return cwd;
}

function electronCommand(root, args) {
  const action = args[0];
  if (!["preflight", "status", "checkout", "verify", "sync", "build"].includes(action))
    throw Error("Use electron preflight|status|checkout|verify|sync|build");
  if (args.some((arg) => arg === "--root" || arg.startsWith("--root=")))
    throw Error("The build workspace owns the Electron root");
  const python = process.env.OPENCRAFT_BUILD_PYTHON ?? "python3";
  if (action === "preflight")
    return [python, [join(repository, "vendor/electron/ci.py"), "preflight", "--target", "linux-x64", "--root", root]];
  const fork = readFileSync(join(repository, "vendor/electron/fork.json"));
  const identity = createHash("sha256").update(fork).digest("hex").slice(0, 16);
  const source = join(root, "worktrees", "electron", identity);
  const rest = args.slice(1);
  if (action === "build" && !rest.some((arg) => arg === "--jobs" || arg.startsWith("--jobs=")))
    rest.push("--jobs", String(Math.min(4, availableParallelism())));
  return [python, [join(repository, "vendor/electron/manage.py"), action, "--root", source, ...rest]];
}

async function runBuild(volume, command, args, env) {
  const logDirectory = join(volume.root, "logs", String(process.getuid()));
  mkdirSync(logDirectory, { recursive: true });
  const log = join(logDirectory, new Date().toISOString().replaceAll(":", "-") + "-" + process.pid + ".log");
  const fd = openSync(log, "wx", 0o640);
  appendFileSync(fd, JSON.stringify({ startedAt: new Date().toISOString(), program: basename(command) }) + "\n");
  console.error("Build log: " + log);
  const child = spawn(command, args, { env, stdio: ["inherit", "pipe", "pipe"] });
  child.stdout.on("data", (data) => {
    appendFileSync(fd, data);
    process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    appendFileSync(fd, data);
    process.stderr.write(data);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  const result = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => accept({ code, signal }));
  }).finally(() => closeSync(fd));
  process.exitCode = result.code ?? 1;
}

export async function main(input = process.argv.slice(2)) {
  process.umask(0o002);
  const volume = checkedVolume();
  const args = [...input];
  const locked = args[0] === "--locked";
  if (locked) args.shift();
  const action = args.shift() ?? "status";
  if (action === "status") {
    console.log(
      JSON.stringify(
        {
          root: volume.root,
          filesystemUuid: volume.metadata.filesystemUuid,
          availableGiB: volume.availableGiB,
          paths: buildPaths(volume.root),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!["worktree", "run", "electron", "container"].includes(action))
    throw Error("Use status|worktree [revision]|run -- command|electron action|container -- buildx-arguments");
  if (!locked) {
    const result = spawnSync(
      "flock",
      [
        "-n",
        "-E",
        "75",
        join(volume.root, "locks", "build.lock"),
        process.execPath,
        script,
        "--locked",
        action,
        ...args,
      ],
      { stdio: "inherit", env: process.env },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  const minimum =
    action === "electron" && ["preflight", "checkout", "sync"].includes(args[0]) ? 200 : action === "worktree" ? 1 : 5;
  if (volume.availableGiB < minimum)
    throw Error("Build volume requires " + minimum + " GiB free; found " + volume.availableGiB);
  if (action === "worktree") {
    if (args.length > 1) throw Error("Use worktree [revision]");
    const revision = git(repository, "rev-parse", "--verify", (args[0] ?? "HEAD") + "^{commit}");
    const directory = join(volume.root, "worktrees", "opencraft", revision);
    mkdirSync(dirname(directory), { recursive: true });
    if (existsSync(directory)) {
      if (
        realpathSync(directory) !== directory ||
        git(directory, "rev-parse", "HEAD") !== revision ||
        git(directory, "diff", "--name-only", "HEAD")
      )
        throw Error("Existing worktree is not the selected clean commit");
    } else git(repository, "worktree", "add", "--detach", directory, revision);
    console.log(directory);
    return;
  }
  const paths = buildPaths(volume.root);
  for (const value of new Set(Object.values(paths))) mkdirSync(value, { recursive: true });
  const env = { ...process.env, ...paths };
  let command, parameters;
  if (action === "electron") [command, parameters] = electronCommand(volume.root, args);
  else {
    requireWorktree(volume.root);
    if (args[0] === "--") args.shift();
    if (action === "run") {
      if (!args.length) throw Error("Supply a build command");
      [command, ...parameters] = args;
    } else {
      if (!process.env.OPENCRAFT_BUILD_BUILDER)
        throw Error("Set OPENCRAFT_BUILD_BUILDER to the dedicated volume-backed BuildKit builder");
      if (!args.length) throw Error("Supply docker buildx build arguments");
      command = "docker";
      parameters = ["buildx", "build", "--builder", process.env.OPENCRAFT_BUILD_BUILDER, ...args];
    }
  }
  await runBuild(volume, command, parameters, env);
}

if (process.argv[1] && resolve(process.argv[1]) === script)
  main().catch((error) => {
    console.error("Build workspace: " + error.message);
    process.exitCode = 1;
  });
