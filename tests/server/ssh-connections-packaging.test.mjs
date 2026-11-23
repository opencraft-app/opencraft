import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const banner = { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" };

function hostKey() {
  const alg = Buffer.from("ssh-ed25519"),
    prefix = Buffer.alloc(4),
    size = Buffer.alloc(4);
  prefix.writeUInt32BE(alg.length);
  size.writeUInt32BE(32);
  return `fixture.invalid ssh-ed25519 ${Buffer.concat([prefix, alg, size, randomBytes(32)]).toString("base64")}`;
}

// Packaged servers bundle the caller; its owner Worker must sit beside it as
// ssh-connections-worker.mjs, or the server cannot open SSH storage.
test("a bundled SSH connections owner starts its packaged Worker beside the bundle", async () => {
  const output = await mkdtemp(join(tmpdir(), "ssh-owner-package-"));
  try {
    const options = { bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent" };
    await build({
      ...options,
      entryPoints: [join(root, "apps/opencraft-daemon/src/ssh-connections.worker.ts")],
      outfile: join(output, "ssh-connections-worker.mjs"),
    });
    await build({
      ...options,
      entryPoints: [join(root, "apps/opencraft-daemon/src/ssh-connections.ts")],
      outfile: join(output, "server.mjs"),
    });
    const { SshConnections } = await import(pathToFileURL(join(output, "server.mjs")).href);
    const connections = await SshConnections.open(join(output, "ssh"));
    try {
      const row = await connections.save(
        null,
        0,
        {
          displayName: "Fixture",
          hostname: "fixture.invalid",
          port: 22,
          username: "fixture",
          enabled: true,
          workspaceBrowseRoots: ["/remote"],
          password: "synthetic-password-only",
        },
        hostKey(),
      );
      assert.equal(
        await connections.binding(row.serverId).connection.authentication.resolvePassword(),
        "synthetic-password-only",
      );
    } finally {
      await connections.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("every package that bundles a network process builds the owner Workers beside it", async () => {
  const { OWNER_WORKERS } = await import("../../scripts/packaging/owner-workers.mjs");
  assert.ok(OWNER_WORKERS.some(([entry, file]) => entry.endsWith("ssh-connections.worker.ts") && file === "ssh-connections-worker.mjs"));
  assert.ok(OWNER_WORKERS.some(([entry, file]) => entry.endsWith("hub-state.worker.ts") && file === "hub-state-worker.mjs"));
  assert.ok(OWNER_WORKERS.some(([, file]) => file === "memory-browser-offline-worker.mjs"));
  assert.ok(OWNER_WORKERS.some(([entry, file]) => entry.endsWith("headless-server/src/server-core-worker.mjs") && file === "server-core-worker.mjs"));
  assert.ok(OWNER_WORKERS.some(([entry, file]) => entry.endsWith("plugins/im/src/switchboard.worker.ts") && file === "switchboard-worker.mjs"));
  assert.ok(OWNER_WORKERS.some(([entry, file]) => entry.endsWith("plugins/thread-participants/src/thread-participants.worker.ts") && file === "thread-participants-worker.mjs"));
  for (const name of ["scripts/packaging/package-web-server.mjs", "scripts/packaging/package-headless-linux.mjs", "scripts/packaging/package-relay.mjs", "apps/opencraft-daemon/build.mjs"]) {
    const source = await readFile(join(root, name), "utf8");
    assert.match(source, /await buildOwnerWorkers\(/, `${name} builds the owner Workers`);
  }
});

// A Host bundles the assistant supervisor; offline memory browsing starts its
// packaged Worker beside the bundle instead of reading SQLite on the Host thread.
test("a bundled assistant Host reads offline memory through its packaged Worker", async () => {
  const output = await mkdtemp(join(tmpdir(), "assistant-owner-package-"));
  try {
    const { buildOwnerWorkers } = await import("../../scripts/packaging/owner-workers.mjs");
    await buildOwnerWorkers(output);
    await build({
      bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent",
      entryPoints: [join(root, "apps/personal-assistant/src/runtime/host-supervisor.mjs")],
      outfile: join(output, "host.mjs"),
      external: ["@earendil-works/*"],
    });
    const { createPersonalAssistantHost } = await import(pathToFileURL(join(output, "host.mjs")).href);
    const directory = join(output, "assistants");
    await mkdir(directory, { mode: 0o700 });
    const host = await createPersonalAssistantHost({
      directory,
      service: { attachPersonalAssistantHost: () => () => {} },
      readConfig: async () => null,
    });
    try {
      const binding = { botId: "bot-1", owner: { kind: "human", id: "fixture:user" }, grantId: "grant-1" };
      const result = await host.memory("bot-1", 1, { action: "list" }, binding);
      assert.ok(result && typeof result === "object", "the offline Worker answered");
    } finally {
      await host.close?.();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

// Headless starts its Server owner Worker beside its bundle, as it does from source.
test("a bundled Headless caller serves Server domains from its packaged owner Worker", async () => {
  const output = await mkdtemp(join(tmpdir(), "server-core-owner-package-"));
  try {
    const { buildOwnerWorkers } = await import("../../scripts/packaging/owner-workers.mjs");
    await buildOwnerWorkers(output);
    await build({
      bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent",
      nodePaths: [join(root, "node_modules")],
      stdin: {
        resolveDir: root,
        sourcefile: "server-core-caller.mjs",
        contents: [
          'import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";',
          'import { ownerEntry } from "@opencraft/worker-owner";',
          "export const open = (directory) => openServerCoreOwner(directory, { entry: ownerEntry(import.meta.url, 'server-core') });",
        ].join("\n"),
      },
      outfile: join(output, "caller.mjs"),
    });
    const { open } = await import(pathToFileURL(join(output, "caller.mjs")).href);
    const directory = join(output, "data");
    await mkdir(directory, { mode: 0o700 });
    const storage = await open(directory);
    try {
      const result = await storage.call.exchangeThreadNote("server", "thread", "", "AA==");
      assert.equal(typeof result.update, "string", "the packaged owner Worker answered");
    } finally {
      await storage.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

// The IM switchboard is opened by code bundled into Headless; its Worker ships beside the bundle.
test("a bundled IM caller opens the switchboard in its packaged owner Worker", async () => {
  const output = await mkdtemp(join(tmpdir(), "switchboard-package-"));
  try {
    const { buildOwnerWorkers } = await import("../../scripts/packaging/owner-workers.mjs");
    await buildOwnerWorkers(output);
    await build({
      bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent",
      nodePaths: [join(root, "node_modules")],
      stdin: {
        resolveDir: root,
        sourcefile: "switchboard-caller.mjs",
        contents: 'export { Switchboard } from "@opencraft/plugin-im/switchboard";',
      },
      outfile: join(output, "caller.mjs"),
    });
    const { Switchboard } = await import(pathToFileURL(join(output, "caller.mjs")).href);
    const board = await Switchboard.open(join(output, "im.sqlite"));
    try {
      const config = { id: "bot", provider: "wecom", ownerId: "owner", name: "bot", groupScope: "chat" };
      await board.saveChannel(config, true, null);
      assert.equal(board.channel("bot")?.enabled, true, "the packaged owner committed and returned the projection");
    } finally {
      await board.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
