import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  nodeDesktopDirectoryFileSystem,
  prepareDesktopDirectories,
  resolveDesktopDirectoryPlan,
} from "../apps/workbench-electron/src/desktop-directories.ts";
import {
  desktopPreviewProduct,
  desktopProduct,
} from "../apps/workbench-electron/src/product-identity.ts";
import { daemonLaunchSpec } from "../apps/workbench-electron/src/daemon-client.ts";

const appDataDirectory = "/Users/test/Library/Application Support";
const homeDirectory = "/Users/test";

test("production and Preview resolve stable Vela-free directory identities", () => {
  const production = resolveDesktopDirectoryPlan({
    appDataDirectory,
    homeDirectory,
    product: desktopProduct,
  });
  assert.equal(production.userDataDirectory, `${appDataDirectory}/OpenCraft`);
  assert.equal(production.legacyUserDataDirectory, `${appDataDirectory}/@vela/workbench-electron`);
  assert.equal(production.runtimeDirectory, `${appDataDirectory}/OpenCraft/runtime`);
  assert.equal(production.dshDataDirectory, `${appDataDirectory}/OpenCraft/dsh`);
  assert.equal(production.codexDataDirectory, `${appDataDirectory}/OpenCraft/codex`);
  assert.equal(production.daemonEndpoint, `${appDataDirectory}/OpenCraft/opencraft-daemon.sock`);
  assert.equal(production.daemonTokenPath, `${appDataDirectory}/OpenCraft/opencraft-daemon.token`);
  assert.equal(production.productHomeDirectory, `${homeDirectory}/.opencraft`);
  assert.equal(production.migrationAllowed, true);

  const preview = resolveDesktopDirectoryPlan({
    appDataDirectory,
    homeDirectory,
    product: desktopPreviewProduct,
  });
  assert.equal(preview.userDataDirectory, `${appDataDirectory}/OpenCraft Preview`);
  assert.equal(preview.legacyUserDataDirectory, `${appDataDirectory}/@vela/workbench-electron-preview`);
  assert.notEqual(preview.runtimeDirectory, production.runtimeDirectory);
});

test("explicit profile and product-home overrides stay authoritative and skip migration", () => {
  const plan = resolveDesktopDirectoryPlan({
    appDataDirectory,
    homeDirectory,
    product: desktopProduct,
    requestedUserDataDirectory: "/tmp/opencraft-test-profile",
    requestedProductHomeDirectory: "/tmp/opencraft-product-home",
  });
  assert.equal(plan.userDataDirectory, "/tmp/opencraft-test-profile");
  assert.equal(plan.legacyUserDataDirectory, null);
  assert.equal(plan.productHomeDirectory, "/tmp/opencraft-product-home");
  assert.equal(plan.migrationAllowed, false);
});

test("legacy production state migrates atomically and retains a rollback link", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-directory-migration-"));
  try {
    const plan = resolveDesktopDirectoryPlan({
      appDataDirectory: root,
      homeDirectory: root,
      product: desktopProduct,
      platform: "darwin",
    });
    assert.ok(plan.legacyUserDataDirectory);
    await mkdir(plan.legacyUserDataDirectory, { recursive: true });
    await writeFile(join(plan.legacyUserDataDirectory, "opencraft-ui.sqlite"), "durable");
    await writeFile(join(plan.legacyUserDataDirectory, "vela-daemon.token"), "legacy-token");
    await writeFile(join(plan.legacyUserDataDirectory, "vela-daemon.sock"), "stale-socket");

    const prepared = await prepareDesktopDirectories(plan, {
      legacyDaemonIsActive: async () => false,
    });

    assert.equal(prepared.status, "migrated");
    assert.equal(await readFile(join(plan.userDataDirectory, "opencraft-ui.sqlite"), "utf8"), "durable");
    assert.equal(await readFile(plan.daemonTokenPath, "utf8"), "legacy-token");
    await assert.rejects(access(join(plan.userDataDirectory, "vela-daemon.sock")));
    assert.equal((await lstat(plan.legacyUserDataDirectory)).isSymbolicLink(), true);
    assert.equal(await realpath(plan.legacyUserDataDirectory), await realpath(plan.userDataDirectory));
    assert.equal((await lstat(plan.runtimeDirectory)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active legacy daemon keeps the launch on the intact legacy profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-directory-active-"));
  try {
    const plan = resolveDesktopDirectoryPlan({ appDataDirectory: root, homeDirectory: root, product: desktopProduct, platform: "darwin" });
    assert.ok(plan.legacyUserDataDirectory);
    await mkdir(plan.legacyUserDataDirectory, { recursive: true });
    await writeFile(join(plan.legacyUserDataDirectory, "kept"), "yes");
    const prepared = await prepareDesktopDirectories(plan, { legacyDaemonIsActive: async () => true });
    assert.equal(prepared.status, "legacy-active");
    assert.equal(prepared.paths.userDataDirectory, plan.legacyUserDataDirectory);
    assert.equal(await readFile(join(plan.legacyUserDataDirectory, "kept"), "utf8"), "yes");
    await assert.rejects(access(plan.userDataDirectory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed post-rename migration rolls back and launches from the legacy profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-directory-rollback-"));
  try {
    const plan = resolveDesktopDirectoryPlan({ appDataDirectory: root, homeDirectory: root, product: desktopProduct, platform: "darwin" });
    assert.ok(plan.legacyUserDataDirectory);
    await mkdir(plan.legacyUserDataDirectory, { recursive: true });
    await writeFile(join(plan.legacyUserDataDirectory, "vela-daemon.token"), "legacy-token");
    const prepared = await prepareDesktopDirectories(plan, {
      legacyDaemonIsActive: async () => false,
      fileSystem: {
        ...nodeDesktopDirectoryFileSystem,
        async rename(source, destination) {
          if (source.endsWith("vela-daemon.token")) throw new Error("injected token migration failure");
          await nodeDesktopDirectoryFileSystem.rename(source, destination);
        },
      },
    });
    assert.equal(prepared.status, "legacy-fallback");
    assert.equal(prepared.paths.userDataDirectory, plan.legacyUserDataDirectory);
    assert.equal(await readFile(join(plan.legacyUserDataDirectory, "vela-daemon.token"), "utf8"), "legacy-token");
    await assert.rejects(access(plan.userDataDirectory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon launch consumes resolver-owned endpoint, token and runtime cwd", () => {
  const spec = daemonLaunchSpec({
    endpoint: "/state/OpenCraft/opencraft-daemon.sock",
    tokenPath: "/state/OpenCraft/opencraft-daemon.token",
    runtimeDirectory: "/state/OpenCraft/runtime",
    daemonEntry: "/app/runtime/opencraft-daemon.cjs",
    dshExecutable: "/app/runtime/dsh/bin.js",
    dshCapabilityPlugin: "/app/runtime/dsh/plugin.mjs",
    dataDirectory: "/state/OpenCraft/dsh",
    modelStorageDirectory: "/Users/test/.opencraft",
    skillsDirectory: "/Users/test/.opencraft/skills",
    codexExecutable: "/Users/test/.local/bin/codex",
    codexDataDirectory: "/state/OpenCraft/codex",
    nativeCodexHomeDirectory: "/Users/example/.codex",
    executable: "/Applications/OpenCraft.app/Contents/MacOS/OpenCraft",
  }, "secret");
  assert.equal(spec.options.cwd, "/state/OpenCraft/runtime");
  assert.equal(spec.options.env.OPENCRAFT_DAEMON_AUTH_TOKEN, "secret");
  assert.deepEqual(spec.args.slice(0, 4), [
    "/app/runtime/opencraft-daemon.cjs",
    "--endpoint",
    "/state/OpenCraft/opencraft-daemon.sock",
    "--runtime-directory",
  ]);
  assert.ok(spec.args.includes("/state/OpenCraft/runtime"));
  assert.ok(spec.args.includes("/Users/test/.local/bin/codex"));
  assert.ok(spec.args.includes("/state/OpenCraft/codex"));
  assert.ok(spec.args.includes("/Users/example/.codex"));
});
