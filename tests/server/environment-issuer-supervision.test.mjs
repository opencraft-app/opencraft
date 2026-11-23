import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentPaths } from "../../scripts/container-deployment/paths.mjs";
import {
  dshHostConfiguration,
  engineHostConfiguration,
  executionHostIssuer,
  relaunchOnIssuerChange,
  writeExecutionHostConfigurations,
} from "../../scripts/container-deployment/execution-hosts.mjs";
import {
  pinPublishedEnvironmentIssuer,
  readPublishedEnvironmentIssuer,
  resolveEnvironmentIssuer,
  watchEnvironmentIssuer,
} from "../../scripts/server-deployment/environment-issuer.mjs";

const key = () => generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const quiet = () => {};

async function deployment(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-issuer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { OPENCRAFT_DATA_DIR: join(root, "state"), OPENCRAFT_WORKSPACE_DIR: join(root, "work"), ...extra };
  const paths = deploymentPaths(env);
  await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
  return { root, env, paths };
}
const publish = (path, issuer, mode = 0o600) =>
  writeFile(path, JSON.stringify({ schemaVersion: 1, issuer }) + "\n", { mode }).then(() => chmod(path, mode));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("without ENV delivery Brain writes exactly the previous host configurations", async (t) => {
  const { env, paths } = await deployment(t);
  assert.equal(paths.environmentDelivery, null);
  assert.equal(await executionHostIssuer(paths, quiet), undefined);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, undefined);
  const engine = await readJson(paths.engineConfig),
    dsh = await readJson(paths.dshConfig);
  assert.deepEqual(engine, {
    descriptorPath: paths.engineDescriptor,
    dataDirectory: paths.dataDirectory,
    runtimeDirectory: paths.runtimeDirectory,
    engines: ["dsh", "pi"],
    defaultEngine: "pi",
    executionContext: "assets",
    gitWorkerFile: "/opt/opencraft/runtime/personal-git-worker.mjs",
    dshDescriptorPath: paths.dshDescriptor,
    fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
  });
  assert.ok(!("environmentIssuer" in dsh));
  assert.equal(dsh.descriptorPath, paths.dshDescriptor);
  for (const path of [paths.engineConfig, paths.dshConfig]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  // The watcher is not even started without delivery.
  let watched = false;
  await relaunchOnIssuerChange({
    paths,
    root: "/opt/opencraft",
    env,
    signal: AbortSignal.abort(),
    relaunch: async () => {},
    watch: async () => {
      watched = true;
    },
  });
  assert.equal(watched, false);
});

test("ENV delivery is a deployment setting that needs the Assets context and the deployment issuer path", async (t) => {
  const { root } = await deployment(t);
  const base = { OPENCRAFT_DATA_DIR: join(root, "state"), OPENCRAFT_WORKSPACE_DIR: join(root, "work") };
  const paths = deploymentPaths({ ...base, OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner" });
  assert.equal(paths.environmentDelivery, "vault-owner");
  assert.equal(paths.environmentIssuerFile, join(root, "state", "run", "environment-issuer.json"));
  assert.equal(deploymentPaths({ ...base, OPENCRAFT_ENVIRONMENT_DELIVERY: "" }).environmentDelivery, null);
  for (const extra of [
    { OPENCRAFT_ENVIRONMENT_DELIVERY: "synchronous" },
    { OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner", OPENCRAFT_EXECUTION_CONTEXT: "legacy" },
    { OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner", OPENCRAFT_ENVIRONMENT_ISSUER_FILE: join(root, "elsewhere.json") },
    { OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION: "2" },
  ])
    assert.throws(() => deploymentPaths({ ...base, ...extra }), JSON.stringify(extra));
});

test("Brain pins the published issuer into both DSH and Pi host configurations", async (t) => {
  const { env, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner" });
  const issuer = key();
  await publish(paths.environmentIssuerFile, issuer);
  const pinned = await executionHostIssuer(paths, quiet);
  assert.equal(pinned, issuer);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, pinned);
  assert.equal((await readJson(paths.engineConfig)).environmentIssuer, issuer);
  assert.equal((await readJson(paths.dshConfig)).environmentIssuer, issuer);
  assert.deepEqual(engineHostConfiguration(paths, "/opt/opencraft", issuer), {
    ...engineHostConfiguration(paths, "/opt/opencraft"),
    environmentIssuer: issuer,
  });
  assert.deepEqual(dshHostConfiguration(paths, "/opt/opencraft", env, issuer), {
    ...dshHostConfiguration(paths, "/opt/opencraft", env),
    environmentIssuer: issuer,
  });
});

test("a missing or untrusted publication never supplies a key: hosts pin an unissuable key", async (t) => {
  const { root, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner" });
  const logs = [];
  // Missing: a valid key nothing can issue for, distinct on every launch.
  const missing = await executionHostIssuer(paths, (message) => logs.push(JSON.parse(message)));
  assert.match(missing, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(missing, await executionHostIssuer(paths, quiet));
  assert.deepEqual(logs, [{ type: "environment-issuer-unavailable", reason: "missing" }]);
  assert.equal(await readPublishedEnvironmentIssuer(paths.environmentIssuerFile), null);
  const forged = key(),
    path = paths.environmentIssuerFile;
  const cases = [
    ["readable by others", () => publish(path, forged, 0o644)],
    [
      "symlink",
      async () => {
        const target = join(root, "target.json");
        await publish(target, forged);
        await symlink(target, path);
      },
    ],
    [
      "extra field",
      () => writeFile(path, JSON.stringify({ schemaVersion: 1, issuer: forged, from: "request" }), { mode: 0o600 }),
    ],
    [
      "malformed key",
      () => writeFile(path, JSON.stringify({ schemaVersion: 1, issuer: "not a key" }), { mode: 0o600 }),
    ],
    ["other schema", () => writeFile(path, JSON.stringify({ schemaVersion: 2, issuer: forged }), { mode: 0o600 })],
    ["not JSON", () => writeFile(path, forged, { mode: 0o600 })],
  ];
  for (const [name, plant] of cases) {
    await rm(path, { force: true });
    await plant();
    await assert.rejects(readPublishedEnvironmentIssuer(path), name);
    const resolved = await resolveEnvironmentIssuer(path);
    assert.equal(resolved.published, false, name);
    assert.equal(resolved.reason, "refused", name);
    assert.notEqual(resolved.issuer, forged, name);
  }
  await assert.rejects(readPublishedEnvironmentIssuer("relative.json"));
});

test("launch-time pinning under systemd reads only the named publication", async (t) => {
  const { paths } = await deployment(t);
  const unchanged = { descriptorPath: "/run/descriptor.json", executionContext: "assets" };
  assert.equal(await pinPublishedEnvironmentIssuer(unchanged), unchanged);
  const issuer = key();
  await publish(paths.environmentIssuerFile, issuer);
  assert.deepEqual(
    await pinPublishedEnvironmentIssuer({ ...unchanged, environmentIssuerFile: paths.environmentIssuerFile }),
    { ...unchanged, environmentIssuer: issuer },
  );
  await assert.rejects(
    pinPublishedEnvironmentIssuer({
      ...unchanged,
      environmentIssuer: issuer,
      environmentIssuerFile: paths.environmentIssuerFile,
    }),
  );
  await rm(paths.environmentIssuerFile);
  const logs = [];
  const pending = await pinPublishedEnvironmentIssuer(
    { ...unchanged, environmentIssuerFile: paths.environmentIssuerFile },
    (m) => logs.push(m),
  );
  assert.notEqual(pending.environmentIssuer, issuer);
  assert.equal(logs.length, 1);
});

test("a vault-owner restart with a new key relaunches DSH and Pi with it; until then they keep the old pin", async (t) => {
  const { env, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner" });
  const first = key(),
    second = key();
  await publish(paths.environmentIssuerFile, first);
  const pinned = await executionHostIssuer(paths, quiet);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, pinned);
  // Fake process supervisor: records the order and the configuration each start sees.
  const events = [];
  let running = true;
  const controller = new AbortController();
  let relaunched;
  const done = new Promise((accept) => {
    relaunched = accept;
  });
  const watching = relaunchOnIssuerChange({
    paths,
    root: "/opt/opencraft",
    env,
    pinned,
    signal: controller.signal,
    interval: 5,
    log: quiet,
    relaunch: async (configure) => {
      events.push(["stop", (await readJson(paths.engineConfig)).environmentIssuer]);
      running = false;
      await configure();
      running = true;
      events.push([
        "start",
        (await readJson(paths.engineConfig)).environmentIssuer,
        (await readJson(paths.dshConfig)).environmentIssuer,
      ]);
      relaunched();
    },
  });
  // The same key republished by a restarted owner relaunches nothing.
  await publish(paths.environmentIssuerFile, first);
  await new Promise((accept) => setTimeout(accept, 30));
  assert.deepEqual(events, []);
  // An untrusted replacement is ignored; the hosts keep the previous pin.
  await publish(paths.environmentIssuerFile, second, 0o644);
  await new Promise((accept) => setTimeout(accept, 30));
  assert.deepEqual(events, []);
  await chmod(paths.environmentIssuerFile, 0o600);
  await done;
  controller.abort();
  await watching;
  assert.equal(running, true);
  assert.deepEqual(events, [
    ["stop", first],
    ["start", second, second],
  ]);
});

test("a failed relaunch stops the supervisor loop instead of leaving hosts half configured", async () => {
  const controller = new AbortController();
  const values = ["b"];
  await assert.rejects(
    watchEnvironmentIssuer({
      path: "/unused",
      pinned: "a",
      signal: controller.signal,
      interval: 1,
      log: quiet,
      read: async () => values.shift() ?? "b",
      replace: async () => {
        throw new Error("relaunch failed");
      },
    }),
    /relaunch failed/,
  );
});
