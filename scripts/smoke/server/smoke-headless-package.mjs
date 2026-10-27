#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WebSocket from "ws";
import { assertHeadlessWebRelease } from "../../headless-web-release.mjs";
import { startHeadlessSmokeProcess } from "../../headless-smoke-process.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const exec = promisify(execFile);

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyManifest(root, manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.files));
  for (const item of manifest.files) {
    const path = resolve(root, item.path);
    assert.ok(path.startsWith(`${root}${sep}`), `Invalid package path: ${item.path}`);
    const info = await lstat(path);
    if (item.sha256) {
      assert.ok(info.isFile(), `Not a file: ${item.path}`);
      assert.equal(await hashFile(path), item.sha256, `Package checksum mismatch: ${item.path}`);
    } else {
      assert.ok(info.isSymbolicLink(), `Not a symlink: ${item.path}`);
      assert.equal(await readlink(path), item.link);
    }
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

function rpc(socket, id, method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    const receive = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.id !== id) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
      else resolvePromise(frame.result);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

export async function smokeCodexAppHost(origin, projectPath = null) {
  const socket = new WebSocket(`${origin.replace(/^http/u, "ws")}/apphost`, { origin });
  const frames = [];
  socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const frame = frames.find(predicate);
      if (frame) return frame;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Codex ${label} timed out`);
  };
  try {
    await new Promise((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: "headless-smoke" }));
    await waitFor(frame => frame.type === "ready", "AppHost hello");
    socket.send(JSON.stringify({ type: "host/connect", requestId: "codex-connect", hostId: "local-codex", leaseId: "smoke-lease" }));
    const connected = await waitFor(frame => frame.type === "response" && frame.requestId === "codex-connect", "Host connect");
    assert.equal(connected.ok, true, JSON.stringify(connected.error));
    const send = (requestId, id, method, params = {}) => {
      socket.send(JSON.stringify({
        type: "host/send", requestId, hostId: "local-codex", leaseId: "smoke-lease",
        generation: connected.result.generation,
        frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }));
    };
    send("codex-initialize-send", "codex-initialize", "initialize", {
      clientInfo: { name: "opencraft-headless-smoke", version: "1" },
      capabilities: { experimentalApi: true },
    });
    const initialized = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === "codex-initialize", "initialize");
    const initializeResult = JSON.parse(initialized.frame);
    assert.ok(initializeResult.result, JSON.stringify(initializeResult.error));
    assert.equal(initializeResult.result.opencraftQueueSteerVersion, undefined);
    assert.deepEqual(initializeResult.result.capabilities?.extensions?.["opencraft/thread-queue"], {
      version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, perItemPause: false,
    });
    const lifecycle = initializeResult.result.capabilities?.extensions?.["opencraft/thread-lifecycle"];
    assert.equal(lifecycle?.rename, true);
    assert.equal(lifecycle?.archive, true);
    send("codex-queue-list-send", "codex-queue-list", "thread/queue/list", {
      threadId: "00000000-0000-0000-0000-000000000000",
    });
    const queueListed = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === "codex-queue-list", "Host queue list");
    assert.deepEqual(JSON.parse(queueListed.frame).result, { data: [], nextCursor: null, steering: [] });
    send("codex-accounts-send", "codex-accounts", "opencraft/codex/accounts/list");
    const accounts = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === "codex-accounts", "account list");
    assert.ok(Array.isArray(JSON.parse(accounts.frame).result?.accounts));
    if (projectPath !== null) {
      send("codex-directory-send", "codex-directory", "fs/readDirectory", { path: dirname(projectPath) });
      const directory = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === "codex-directory", "directory browse");
      assert.ok(JSON.parse(directory.frame).result?.entries.some(entry => entry.fileName === "picker-project" && entry.isDirectory));
      send("codex-project-send", "codex-project", "project/create", {
        name: "picker-project",
        roots: [{ path: projectPath }],
        idempotencyKey: `headless-smoke:${projectPath}`,
      });
      const created = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === "codex-project", "project create");
      assert.ok(JSON.parse(created.frame).result?.project?.roots.some(root => root.path === projectPath),
        JSON.stringify(JSON.parse(created.frame).error));
    }
  } finally {
    socket.terminate();
  }
}

export async function smokeHeadlessPackage(archive) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Headless package smoke requires Linux x64");
  }
  const directory = await mkdtemp(join(tmpdir(), "opencraft-headless-smoke-"));
  let child;
  let smokeProcess;
  let socket;
  try {
    const { stdout: entries } = await exec("tar", ["-tzf", archive], { maxBuffer: 32 * 1024 * 1024 });
    for (const entry of entries.trim().split("\n")) {
      assert.ok(entry === "opencraft-server/" ||
        (entry.startsWith("opencraft-server/") && !entry.split("/").includes("..")),
      `Unsafe archive path: ${entry}`);
    }
    await run("tar", ["-xzf", archive, "-C", directory]);
    const root = join(directory, "opencraft-server");
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.platform, "linux");
    assert.equal(manifest.architecture, "amd64");
    assert.equal(manifest.buildId, (await assertHeadlessWebRelease(join(root, "web"))).buildId);
    await verifyManifest(root, manifest);
    smokeProcess = startHeadlessSmokeProcess(join(root, "bin/opencraft-server"), ["--port", "0", "--data-dir", join(directory, "data")], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = smokeProcess.child;
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => { errors = (errors + chunk.toString()).slice(-4000); });
    const url = await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 60_000);
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4000);
        const match = /OpenCraft WebUI: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
        if (match) { clearTimeout(timeout); resolvePromise(match[1]); }
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited before ready (${code}): ${errors}`));
      });
    });
    const healthResponse = await fetch(`${url}/__opencraft_health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.appServerConfigured, true);
    assert.ok(Array.isArray(health.storage) && health.storage.length > 0,
      "Headless startup must report its opened storage owners");
    for (const storage of health.storage) {
      assert.equal(storage.movedAside, false, `Unexpected storage recovery: ${storage.name}`);
    }
    assert.match(await fetch(url).then((response) => response.text()), /opencraft-build-id/u);
    socket = new WebSocket(`${url.replace(/^http/u, "ws")}/appserver`, { origin: url });
    await new Promise((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const initialized = await rpc(socket, 1, "initialize");
    assert.equal(typeof initialized.codexHome, "string");
    const threads = await rpc(socket, 2, "thread/list");
    assert.ok(Array.isArray(threads.data));
    assert.equal(threads.data.length, 0);
    const projectPath = join(directory, "picker-project");
    await mkdir(projectPath);
    const fileSystem = await rpc(socket, 3, "fs/readDirectory", { path: directory });
    assert.ok(fileSystem.entries.some(entry => entry.fileName === "picker-project" && entry.isDirectory));
    const project = await rpc(socket, 4, "project/create", {
      name: "picker-project",
      roots: [{ path: projectPath }],
      idempotencyKey: `headless-smoke:${projectPath}`,
    });
    assert.ok(project.project.roots.some(root => root.path === projectPath));
    await smokeCodexAppHost(url, projectPath);
    process.stdout.write(`Headless Linux package smoke passed: ${manifest.buildId}\n`);
  } finally {
    socket?.terminate();
    await smokeProcess?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2] || join(repositoryRoot, "release/OpenCraft-server-0.1.0-linux-amd64.tar.gz");
  smokeHeadlessPackage(resolve(archive)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
