import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentPaths } from "../../scripts/container-deployment/paths.mjs";
import {
  codexAppServerEnvironmentArguments,
  codexAppServerEnvironmentLaunch,
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
import { readEnvironmentLaunchConfiguration } from "../../apps/codex-core/src/environment-launch-config.ts";

const key = () => generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const quiet = () => {};
const machineId = "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function deployment(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-issuer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { OPENCRAFT_DATA_DIR: join(root, "state"), OPENCRAFT_WORKSPACE_DIR: join(root, "work"), ...extra };
  const paths = deploymentPaths(env);
  await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
  return { root, env, paths };
}
// Publishes like the owner does: a complete file with its final mode replaces the old one at once, so a polling
// reader never sees new content under the previous mode.
const publish = async (path, issuer, mode = 0o600) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, issuer }) + "\n", { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
};
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("without ENV delivery Brain writes exactly the previous host configurations", async (t) => {
  const { env, paths } = await deployment(t);
  assert.equal(paths.environmentDelivery, null);
  assert.equal(await executionHostIssuer(paths, quiet), undefined);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, undefined);
  const engine = await readJson(paths.engineConfig),
    dsh = await readJson(paths.dshConfig);
  const previousEngine = {
    descriptorPath: paths.engineDescriptor,
    dataDirectory: paths.dataDirectory,
    runtimeDirectory: paths.runtimeDirectory,
    engines: ["dsh", "pi"],
    defaultEngine: "pi",
    executionContext: "assets",
    gitWorkerFile: "/opt/opencraft/runtime/personal-git-worker.mjs",
    dshDescriptorPath: paths.dshDescriptor,
    fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
  };
  assert.deepEqual(engine, previousEngine);
  assert.ok(!("environmentIssuer" in dsh));
  assert.equal(dsh.descriptorPath, paths.dshDescriptor);
  // Byte-identical to the configurations written before ENV delivery existed.
  assert.equal(await readFile(paths.engineConfig, "utf8"), JSON.stringify(previousEngine) + "\n");
  assert.equal(
    await readFile(paths.dshConfig, "utf8"),
    JSON.stringify(dshHostConfiguration(paths, "/opt/opencraft", env)) + "\n",
  );
  // The Codex AppServer starts exactly as before: no flag and no launch file,
  // and a stale file from an earlier delivery is removed.
  assert.deepEqual(codexAppServerEnvironmentArguments(paths), []);
  assert.equal(await exists(paths.codexEnvironmentLaunchConfig), false);
  await writeFile(paths.codexEnvironmentLaunchConfig, "{}", { mode: 0o600 });
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, undefined, machineId);
  assert.equal(await exists(paths.codexEnvironmentLaunchConfig), false);
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
  const paths = deploymentPaths({ ...base, OPENCRAFT_ENVIRONMENT_DELIVERY: "opaque" });
  assert.equal(paths.environmentDelivery, "opaque");
  // The earlier spelling has the same meaning; neither names a vault owner.
  assert.deepEqual(deploymentPaths({ ...base, OPENCRAFT_ENVIRONMENT_DELIVERY: "vault-owner" }), paths);
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

test("Brain pins the published issuer into the DSH, Pi and Codex AppServer configurations", async (t) => {
  const { env, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "opaque" });
  const issuer = key();
  await publish(paths.environmentIssuerFile, issuer);
  const pinned = await executionHostIssuer(paths, quiet);
  assert.equal(pinned, issuer);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, pinned, machineId);
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
  // The split Codex AppServer: the same stable key, its own attachment, the
  // admission Worker shipped in Brain's runtime and the server data directory.
  assert.deepEqual(await readJson(paths.codexEnvironmentLaunchConfig), {
    issuer,
    instance: `server:${machineId}:codex`,
    admissionWorkerFile: "/opt/opencraft/runtime/execution-admission-worker.mjs",
    directory: paths.dataDirectory,
  });
  assert.equal((await stat(paths.codexEnvironmentLaunchConfig)).mode & 0o777, 0o600);
  assert.equal(paths.codexEnvironmentLaunchConfig, join(paths.runDirectory, "codex-app-server-environment.json"));
  assert.deepEqual(codexAppServerEnvironmentArguments(paths), [
    "--environment-launch-config",
    paths.codexEnvironmentLaunchConfig,
  ]);
  // The AppServer reads it as configured: a pinned key passes through unchanged.
  assert.deepEqual(
    await readEnvironmentLaunchConfiguration(paths.codexEnvironmentLaunchConfig, quiet),
    await readJson(paths.codexEnvironmentLaunchConfig),
  );
  // Without the machine the Gateway reads, the attachment cannot be named.
  for (const bad of [undefined, "", "../machine"])
    assert.throws(() => codexAppServerEnvironmentLaunch(paths, "/opt/opencraft", bad, issuer));
});

test("with an identity-owned vault Brain pins the key that owner publishes; nothing reads the owner", async (t) => {
  // The Gateway's owner is not part of Brain's configuration: the same
  // deployment setting pins whichever vault owner publishes at the path.
  const { env, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "opaque" });
  // The identity composition's vault Worker publishes the same file core's
  // Worker would (createAssetsStorage environmentIssuer.publish); the Gateway
  // side is covered by headless-composition.test.mjs.
  const identityIssuer = key();
  await publish(paths.environmentIssuerFile, identityIssuer);
  const pinned = await executionHostIssuer(paths, quiet);
  assert.equal(pinned, identityIssuer);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, pinned, machineId);
  assert.equal((await readJson(paths.engineConfig)).environmentIssuer, identityIssuer);
  assert.equal((await readJson(paths.dshConfig)).environmentIssuer, identityIssuer);
  assert.equal((await readJson(paths.codexEnvironmentLaunchConfig)).issuer, identityIssuer);
  assert.deepEqual(codexAppServerEnvironmentArguments(paths), [
    "--environment-launch-config",
    paths.codexEnvironmentLaunchConfig,
  ]);
});

test("a missing or untrusted publication never supplies a key: hosts pin an unissuable key", async (t) => {
  const { root, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "opaque" });
  const logs = [];
  // Missing: a valid key nothing can issue for, distinct on every launch.
  const missing = await executionHostIssuer(paths, (message) => logs.push(JSON.parse(message)));
  assert.match(missing, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(missing, await executionHostIssuer(paths, quiet));
  assert.deepEqual(logs, [{ type: "environment-issuer-unavailable", reason: "missing" }]);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", {}, missing, machineId);
  assert.equal((await readJson(paths.codexEnvironmentLaunchConfig)).issuer, missing);
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

test("a rotated key relaunches DSH, Pi and the Codex AppServer with it; until then they keep the old pin", async (t) => {
  const { env, paths } = await deployment(t, { OPENCRAFT_ENVIRONMENT_DELIVERY: "opaque" });
  const first = key(),
    second = key();
  await publish(paths.environmentIssuerFile, first);
  const pinned = await executionHostIssuer(paths, quiet);
  await writeExecutionHostConfigurations(paths, "/opt/opencraft", env, pinned, machineId);
  // Fake process supervisor: records the order and the configuration each start sees.
  const events = [];
  let running = true;
  const controller = new AbortController();
  t.after(() => controller.abort());
  let relaunched;
  const done = new Promise((accept) => {
    relaunched = accept;
  });
  const watching = relaunchOnIssuerChange({
    paths,
    root: "/opt/opencraft",
    env,
    machineId,
    pinned,
    signal: controller.signal,
    interval: 5,
    log: quiet,
    relaunch: async (configure) => {
      events.push([
        "stop",
        (await readJson(paths.engineConfig)).environmentIssuer,
        (await readJson(paths.codexEnvironmentLaunchConfig)).issuer,
      ]);
      running = false;
      await configure();
      running = true;
      events.push([
        "start",
        (await readJson(paths.engineConfig)).environmentIssuer,
        (await readJson(paths.dshConfig)).environmentIssuer,
        (await readJson(paths.codexEnvironmentLaunchConfig)).issuer,
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
    ["stop", first, first],
    ["start", second, second, second],
  ]);
  assert.equal((await readJson(paths.codexEnvironmentLaunchConfig)).instance, `server:${machineId}:codex`);
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

test("the Codex AppServer resolves a named publication once at launch with the same rules", async (t) => {
  const { root, paths } = await deployment(t);
  const issuer = key();
  const launch = {
    instance: `server:${machineId}:codex`,
    admissionWorkerFile: "/opt/opencraft-engine-host/runtime/execution-admission-worker.mjs",
    directory: paths.dataDirectory,
  };
  const file = join(root, "environment-launch.json");
  await writeFile(file, JSON.stringify({ ...launch, environmentIssuerFile: paths.environmentIssuerFile }), {
    mode: 0o600,
  });
  // Missing publication: a valid key nothing can issue for (fail closed).
  const logs = [];
  const pending = await readEnvironmentLaunchConfiguration(file, (m) => logs.push(JSON.parse(m)));
  assert.deepEqual(Object.keys(pending).sort(), ["admissionWorkerFile", "directory", "instance", "issuer"]);
  assert.match(pending.issuer, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(logs, [{ type: "environment-issuer-unavailable", reason: "missing" }]);
  await publish(paths.environmentIssuerFile, issuer);
  assert.deepEqual(await readEnvironmentLaunchConfiguration(file, quiet), { ...launch, issuer });
  // A publication another user could change is refused, never used.
  await chmod(paths.environmentIssuerFile, 0o644);
  const refused = await readEnvironmentLaunchConfiguration(file, quiet);
  assert.notEqual(refused.issuer, issuer);
  // A pinned key and a publication together, or a non-object, are refused.
  await writeFile(file, JSON.stringify({ ...launch, issuer, environmentIssuerFile: paths.environmentIssuerFile }), {
    mode: 0o600,
  });
  await assert.rejects(readEnvironmentLaunchConfiguration(file, quiet));
  await writeFile(file, "[]", { mode: 0o600 });
  await assert.rejects(readEnvironmentLaunchConfiguration(file, quiet));
});

test("Brain passes the launch file to the AppServer, relaunches it on rotation and ships its admission Worker", async () => {
  const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const [host, packager, gitRuntime, unitService, dropIn, example] = await Promise.all([
    read("scripts/container-deployment/host.mjs"),
    read("scripts/packaging/package-container.mjs"),
    read("scripts/packaging/package-git-identity-runtime.mjs"),
    read("deploy/web-server/opencraft-environment-issuer.service.example"),
    read("deploy/web-server/opencraft-codex-appserver-environment.conf.example"),
    read("deploy/web-server/opencraft-codex-appserver-environment.json.example"),
  ]);
  assert.match(host, /\.\.\.codexAppServerEnvironmentArguments\(paths\)/u);
  assert.match(host, /relaunchOnIssuerChange\(\{[^}]*machineId/u);
  // The rotation relaunch stops and restarts the AppServer like DSH and Pi.
  const relaunch = host.slice(host.indexOf("relaunchOnIssuerChange("));
  assert.ok(relaunch.indexOf("stopAppServer()") > 0 && relaunch.indexOf("startAppServer()") > 0);
  // Brain's runtime ships the Worker its owners name by configuration.
  assert.match(packager, /'execution-admission-worker\.mjs'/u);
  assert.match(packager, /access\(join\(root, 'runtime', name\)\)/u);
  assert.match(gitRuntime, /execution-admission\.worker\.ts'\), name: 'execution-admission-worker\.mjs'/u);
  // systemd: the path unit's service also restarts the AppServer, whose drop-in
  // passes a launch file that names the publication rather than a key.
  assert.match(unitService, /try-restart[^\n]*opencraft-codex-appserver\.service/u);
  assert.match(dropIn, /--environment-launch-config \/etc\/opencraft-codex-appserver\/environment-launch\.json$/mu);
  const launch = JSON.parse(example);
  assert.equal(launch.environmentIssuerFile, "/var/lib/opencraft/run/environment-issuer.json");
  assert.ok(!("issuer" in launch));
});
