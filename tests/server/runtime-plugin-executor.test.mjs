import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, installRuntimePlugin } from "../../packages/runtime-plugin-host/store.mjs";
import {
  runGatewayUtilityMode,
  runRuntimePluginExecutor,
  startRuntimePluginExecutor,
} from "../../scripts/container-deployment/runtime-plugin-tools.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const gateway = join(repository, "scripts/container-deployment/gateway.mjs");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "plugin-executor-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function executionPackage(root, roles = ["execution"]) {
  const output = join(root, "package"),
    store = join(root, "store"),
    marker = join(root, "marker");
  await mkdir(output, { recursive: true });
  const code = `import {writeFile} from 'node:fs/promises';export async function activate(context){await writeFile(${JSON.stringify(marker)},context.role);return {close(){return writeFile(${JSON.stringify(marker)},'closed');}};}`;
  const manifest = {
    schemaVersion: 1,
    id: "fixture.executor",
    version: "1.0.0",
    hostApi: 1,
    nodeMajor: 26,
    sourceRevision: "a".repeat(40),
    roles: Object.fromEntries(
      roles.map((role) => [
        role,
        {
          entry: "entry.mjs",
          ...(role === "gateway" ? { routes: [{ path: "/__fixture_executor", methods: ["GET"] }] } : {}),
        },
      ]),
    ),
    files: [{ path: "entry.mjs", size: Buffer.byteLength(code), sha256: hash(code) }],
  };
  await writeFile(join(output, "entry.mjs"), code);
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest));
  await installRuntimePlugin(output, store, { enable: true });
  return { store, marker, output };
}

test("the Hands environment bootstrap has no runtime plugin lifecycle or utility mode", async () => {
  for (const file of ["hands.mjs", "hands-application.mjs"]) {
    const source = await readFile(join(repository, "scripts/container-deployment", file), "utf8");
    assert.doesNotMatch(source, /loadRuntimePlugins|runtime-plugin|--runtime-plugin/);
  }
});

test("the executor activates only the execution role, and installation alone runs nothing", async () =>
  fixture(async (root) => {
    const { store, marker } = await executionPackage(root);
    await assert.rejects(access(marker));
    const host = await startRuntimePluginExecutor({ directory: store });
    try {
      assert.equal(host.selected.length, 1);
      assert.equal(await readFile(marker, "utf8"), "execution");
    } finally {
      await host.close();
    }
    assert.equal(await readFile(marker, "utf8"), "closed");
  }));

test("a gateway-only plugin is never activated by the executor", async () =>
  fixture(async (root) => {
    const { store, marker } = await executionPackage(root, ["gateway"]);
    const host = await startRuntimePluginExecutor({ directory: store, onDiagnostic: () => {} });
    try {
      assert.equal(host.selected.length, 0);
      await assert.rejects(access(marker));
    } finally {
      await host.close();
    }
  }));

test("executor arguments and source configuration fail closed", async () => {
  for (const args of [[], ["relative/store"], ["/"], ["/store", "extra"]])
    await assert.rejects(runRuntimePluginExecutor(args, {}), /Usage: --runtime-plugin-executor/);
  await assert.rejects(
    runRuntimePluginExecutor(["/store"], { OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY: "/remote" }),
    /Configure all runtime plugin source fields/,
  );
});

test("without a utility mode the caller starts its own Gateway", async () => {
  assert.equal(await runGatewayUtilityMode([]), false);
  assert.equal(await runGatewayUtilityMode(["--data-dir", "/data"]), false);
});

test("the Gateway entry admin mode checks a store without starting the Gateway", async () =>
  fixture(async (root) => {
    const { store } = await executionPackage(root);
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", gateway, "--runtime-plugin-admin", "check", store],
      { cwd: repository, encoding: "utf8", env: { ...process.env, OPENCRAFT_DATA_DIR: join(root, "unused") } },
    );
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.deepEqual(
      result.selected.map((plugin) => [plugin.id, plugin.roles]),
      [["fixture.executor", ["execution"]]],
    );
  }));

test("the Gateway entry executor mode runs until SIGTERM and then closes its plugins", async () =>
  fixture(async (root) => {
    const { store, marker } = await executionPackage(root);
    const child = spawn(process.execPath, ["--import", "tsx", gateway, "--runtime-plugin-executor", store], {
      cwd: repository,
      env: { ...process.env, OPENCRAFT_DATA_DIR: join(root, "unused") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      let ready;
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.startsWith("{")) {
          ready = JSON.parse(line);
          break;
        }
      }
      assert.equal(ready?.type, "runtime-plugin-executor-ready");
      assert.equal(ready.selected.length, 1);
      assert.equal(await readFile(marker, "utf8"), "execution");
      child.kill("SIGTERM");
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.equal(await readFile(marker, "utf8"), "closed");
    } finally {
      child.kill("SIGKILL");
    }
  }));
