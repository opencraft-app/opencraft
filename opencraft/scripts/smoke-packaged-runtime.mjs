#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [binary, resources] = process.argv.slice(2);
if (!binary || !resources) throw new Error("Usage: node scripts/smoke-packaged-runtime.mjs <Electron executable> <resources directory>");
const dataDirectory = await mkdtemp(resolve(tmpdir(), "opencraft-packaged-smoke-"));
const child = spawn(resolve(binary), [
  "--expose-internals",
  resolve(resources, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
  "web", "--host", "127.0.0.1", "--port", "0", "--no-open",
], {
  cwd: dataDirectory,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: dataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise(resolveExit => child.once("close", resolveExit));
try {
  const url = await new Promise((resolveReady, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("Packaged DSH startup timed out")), 30_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Packaged DSH exited (${code})`)); });
    child.stderr.pipe(process.stderr);
    child.stdout.on("data", data => {
      stdout += data;
      const match = /dsh web:\s*(https?:\/\/[^\s]+)/u.exec(stdout);
      if (match) { clearTimeout(timeout); resolveReady(match[1]); }
    });
  });
  const response = await fetch(new URL("/api/host.describe", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "packaged-smoke", method: "host.describe", payload: {} }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.result?.ok, true);
  console.log("Packaged runtime smoke passed: bundled Electron Node + bundled DSH, outside the checkout, fresh data.");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(killTimer);
  }
  await rm(dataDirectory, { recursive: true, force: true });
}
