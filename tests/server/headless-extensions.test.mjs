import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-server.mjs";
import {
  installHeadlessExtensions,
  loadHeadlessExtensions,
  validateHeadlessExtensions,
} from "../../apps/headless-server/src/headless-extensions.mjs";
import {
  claimCommunicationExtension,
  communicationExtension,
  communicationExtensionModule,
  groupCreateOptions,
  installCommunicationExtension,
} from "@opencraft/access-control/communication-extension";
import {
  assistantHostExtension,
  claimAssistantHostExtension,
  installAssistantHostExtension,
} from "@opencraft/personal-assistant/runtime/host-extension";
import { ownedCleanup } from "../support/owned-cleanup.mjs";

const communicationModule = new URL("../fixtures/headless-communication-extension.mjs", import.meta.url);
const assistantModule = new URL("../fixtures/headless-assistant-host-extension.mjs", import.meta.url);

async function fixture(t) {
  const runtime = fileURLToPath(new URL("../../.runtime/", import.meta.url));
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "headless-extensions-"));
  const cleanup = ownedCleanup(t);
  cleanup.last(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Workbench</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "extensions-test",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const options = {
    root,
    webRoot,
    dataDirectory: join(root, "data"),
    port: 0,
    startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
  };
  const module = async (name, source) => {
    const path = join(root, name);
    await writeFile(path, source);
    return pathToFileURL(path);
  };
  return { root, options, module, own: cleanup.own };
}

const missing = (path) =>
  access(path).then(
    () => false,
    () => true,
  );

test("composition shape is validated without importing anything", () => {
  assert.deepEqual(validateHeadlessExtensions(undefined), []);
  assert.deepEqual(validateHeadlessExtensions({}), []);
  // Installation order is fixed by core, not by the caller's key order.
  assert.deepEqual(
    validateHeadlessExtensions({
      assistantHost: { module: assistantModule },
      communication: { module: fileURLToPath(communicationModule) },
    }),
    [
      { kind: "communication", url: communicationModule.href },
      { kind: "assistantHost", url: assistantModule.href },
    ],
  );
  assert.deepEqual(validateHeadlessExtensions({ communication: { module: communicationModule.href } }), [
    { kind: "communication", url: communicationModule.href },
  ]);
  const invalid = [
    [null, /expected an object/],
    [[], /expected an object/],
    ["communication", /expected an object/],
    [{ channels: { module: communicationModule } }, /unknown extension channels/],
    [{ communication: communicationModule }, /expected \{ module \}/],
    [{ communication: {} }, /file URL or an absolute path/],
    [{ communication: { module: communicationModule, value: {} } }, /expected \{ module \}/],
    [{ communication: { module: "./extension.mjs" } }, /file URL or an absolute path/],
    [{ communication: { module: "extension-package" } }, /file URL or an absolute path/],
    [{ communication: { module: "https://example.test/extension.mjs" } }, /file URL or an absolute path/],
    [{ communication: { module: new URL("https://example.test/extension.mjs") } }, /file URL or an absolute path/],
    [
      { assistantHost: { module: "data:text/javascript,export const assistantHostExtension={}" } },
      /assistantHost extension module/,
    ],
    [{ assistantHost: { module: 42 } }, /assistantHost extension module/],
  ];
  for (const [value, error] of invalid)
    assert.throws(() => validateHeadlessExtensions(value), error, JSON.stringify(value));
});

test("no extensions field keeps startup unchanged and installs nothing", async (t) => {
  const f = await fixture(t);
  const app = await startHeadlessServer(f.options);
  f.own(() => app.close());
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal(communicationExtension(), undefined);
  assert.equal(communicationExtensionModule(), undefined);
  assert.equal(assistantHostExtension(), undefined);
  await app.close();
  assert.deepEqual(
    installHeadlessExtensions(await loadHeadlessExtensions(validateHeadlessExtensions(undefined)))(),
    undefined,
  );
});

test("composed extensions are installed before the storage Worker starts and released after close", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "worker-imports");
  process.env.OPENCRAFT_TEST_EXTENSION_MARKER = marker;
  t.after(() => delete process.env.OPENCRAFT_TEST_EXTENSION_MARKER);
  const { communicationExtension: expected } = await import(communicationModule.href);
  const { assistantHostExtension: expectedHost } = await import(assistantModule.href);
  const app = await startHeadlessServer(f.options, {
    extensions: {
      communication: { module: communicationModule },
      assistantHost: { module: fileURLToPath(assistantModule) },
    },
  });
  let closed = false;
  f.own(() => !closed && app.close());
  assert.equal(communicationExtension(), expected);
  assert.equal(communicationExtensionModule(), communicationModule.href);
  assert.deepEqual(groupCreateOptions(), expected.groupCreateOptions);
  assert.equal(assistantHostExtension(), expectedHost);
  // Every storage Worker was created after installation, so each imported the same module.
  assert.match(await readFile(marker, "utf8"), /^(?:worker\n)+$/);
  assert.equal((await fetch(app.url)).status, 200);

  // A second live server cannot install the same extensions again.
  const second = await fixture(t);
  await assert.rejects(
    startHeadlessServer(second.options, { extensions: { communication: { module: communicationModule } } }),
    /communication extension is already installed; install it once/,
  );
  assert.equal(await missing(second.options.dataDirectory), true, "rejected before any resource was created");
  assert.equal(communicationExtension(), expected, "the running server keeps its extension");

  await app.close();
  closed = true;
  assert.equal(communicationExtension(), undefined);
  assert.equal(communicationExtensionModule(), undefined);
  assert.equal(assistantHostExtension(), undefined);

  // Once released, a later server in the same process composes it again.
  const again = await startHeadlessServer(second.options, {
    extensions: { communication: { module: communicationModule } },
  });
  assert.equal(communicationExtension(), expected);
  assert.equal(assistantHostExtension(), undefined);
  await again.close();
  assert.equal(communicationExtension(), undefined);
});

test("malformed modules are rejected before startup creates any resource", async (t) => {
  const f = await fixture(t);
  const cases = [
    [
      { communication: { module: await f.module("no-export.mjs", "export const other = {};") } },
      /does not export communicationExtension/,
    ],
    [
      {
        communication: {
          module: await f.module("default.mjs", "export default { channelFiles() { return false; } };"),
        },
      },
      /does not export communicationExtension/,
    ],
    [
      { communication: { module: await f.module("null.mjs", "export const communicationExtension = null;") } },
      /Invalid communication extension: expected an object/,
    ],
    [
      {
        communication: {
          module: await f.module("unknown.mjs", "export const communicationExtension = { channelFile() {} };"),
        },
      },
      /unknown member channelFile/,
    ],
    [
      {
        communication: {
          module: await f.module("value.mjs", "export const communicationExtension = { command: true };"),
        },
      },
      /command must be a function/,
    ],
    [
      {
        communication: {
          module: await f.module(
            "options.mjs",
            "export const communicationExtension = { groupCreateOptions: [{ id: 'Bad' }] };",
          ),
        },
      },
      /Invalid group creation options/,
    ],
    [
      { communication: { module: await f.module("throws.mjs", "throw new Error('broken module');") } },
      /Could not load Headless communication extension module/,
    ],
    [
      { communication: { module: join(f.root, "absent.mjs") } },
      /Could not load Headless communication extension module/,
    ],
    [
      { assistantHost: { module: await f.module("host-array.mjs", "export const assistantHostExtension = [];") } },
      /Invalid Assistant Host extension: expected an object/,
    ],
    [
      {
        assistantHost: {
          module: await f.module(
            "host-entry.mjs",
            "export const assistantHostExtension = { entryURL: 'https://example.test/x.mjs' };",
          ),
        },
      },
      /entryURL must be a file URL/,
    ],
    [
      {
        assistantHost: {
          module: await f.module("host-member.mjs", "export const assistantHostExtension = { request: 'x' };"),
        },
      },
      /request must be a function/,
    ],
    [
      {
        assistantHost: {
          module: await f.module("host-unknown.mjs", "export const assistantHostExtension = { handle() {} };"),
        },
      },
      /unknown member handle/,
    ],
    [{ communication: { module: "relative.mjs" } }, /file URL or an absolute path/],
  ];
  for (const [extensions, error] of cases) {
    await assert.rejects(
      startHeadlessServer(f.options, { extensions }),
      error,
      JSON.stringify(Object.keys(extensions)),
    );
    assert.equal(await missing(f.options.dataDirectory), true, String(error));
    assert.equal(communicationExtension(), undefined);
    assert.equal(assistantHostExtension(), undefined);
  }
  // An accepted assistant Host extension may name a file entry.
  const loaded = await loadHeadlessExtensions(
    validateHeadlessExtensions({
      assistantHost: {
        module: await f.module(
          "host-ok.mjs",
          "export const assistantHostExtension = { entryURL: new URL('file:///opt/assistant.mjs'), request() {} };",
        ),
      },
    }),
  );
  const release = installHeadlessExtensions(loaded);
  assert.equal(assistantHostExtension(), loaded[0].value);
  release();
  release();
  assert.equal(assistantHostExtension(), undefined);
});

test("composition installs in order and rolls back when a later extension conflicts", async (t) => {
  const f = await fixture(t);
  const communication = { channelFiles: () => false };
  const loaded = [
    { kind: "communication", url: communicationModule.href, value: communication },
    { kind: "assistantHost", url: assistantModule.href, value: { reportFailure() {} } },
  ];
  const releaseHost = claimAssistantHostExtension({ request() {} });
  assert.throws(() => installHeadlessExtensions(loaded), /A different Assistant Host extension is already installed/);
  assert.equal(communicationExtension(), undefined, "the earlier communication extension was released");
  releaseHost();

  const release = installHeadlessExtensions(loaded);
  assert.equal(communicationExtension(), communication);
  assert.equal(communicationExtensionModule(), communicationModule.href);
  assert.equal(assistantHostExtension(), loaded[1].value);
  release();
  assert.equal(communicationExtension(), undefined);
  assert.equal(assistantHostExtension(), undefined);

  // The same conflict through startup fails before any resource is created.
  const heldHost = claimAssistantHostExtension({ request() {} });
  await assert.rejects(
    startHeadlessServer(f.options, {
      extensions: { communication: { module: communicationModule }, assistantHost: { module: assistantModule } },
    }),
    /A different Headless assistantHost extension is already installed/,
  );
  assert.equal(await missing(f.options.dataDirectory), true);
  assert.equal(communicationExtension(), undefined);
  heldHost();
});

test("composition and the import-time installers never replace each other", async () => {
  const value = { channelFiles: () => true };
  const release = claimCommunicationExtension(value, communicationModule.href);
  assert.throws(
    () => claimCommunicationExtension(value, communicationModule.href),
    /already installed; install it once/,
  );
  assert.throws(() => claimCommunicationExtension({}, communicationModule.href), /A different communication extension/);
  // An import-time installer cannot reinstall or replace a composed extension.
  assert.throws(() => installCommunicationExtension(value), /already installed by server composition/);
  assert.throws(() => installCommunicationExtension({}), /already installed by server composition/);
  assert.equal(communicationExtensionModule(), communicationModule.href);
  release();
  assert.throws(() => claimCommunicationExtension(value, "not a url"), /Invalid communication extension module URL/);
  assert.equal(communicationExtension(), undefined);

  const host = { reportFailure() {} };
  const releaseHost = claimAssistantHostExtension(host);
  assert.throws(() => claimAssistantHostExtension(host), /already installed; install it once/);
  assert.throws(() => installAssistantHostExtension(host), /already installed by server composition/);
  releaseHost();

  // The import-time path keeps its existing behavior: the same value is idempotent,
  // a different one conflicts, and composition then refuses to install over it.
  installCommunicationExtension(value);
  installCommunicationExtension(value);
  assert.throws(() => installCommunicationExtension({}), /Communication extension already installed/);
  assert.throws(
    () => claimCommunicationExtension(value, communicationModule.href),
    /already installed; install it once/,
  );
  installAssistantHostExtension(host);
  installAssistantHostExtension(host);
  assert.throws(() => installAssistantHostExtension({}), /Assistant Host extension already installed/);
  await assert.rejects(
    loadHeadlessExtensions(validateHeadlessExtensions({ communication: { module: communicationModule } })),
    /A different Headless communication extension is already installed/,
  );
});
