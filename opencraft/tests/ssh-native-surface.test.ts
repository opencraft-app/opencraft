import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { allowsAppServerMethod, OPENCRAFT_METHOD_ACCESS_EXTENSION, parseAppServerMethodAccess } from "@opencraft/appserver-protocol";
import { routeLogicalClientFrame, stampLogicalClientFrame } from "@opencraft/app-host-protocol";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { CODEX_NATIVE_SHARED_METHODS, projectSharedNativeCodexInitialize } from "../apps/opencraft-daemon/src/codex-native-surface.js";
import { SshCodexTransport } from "../apps/opencraft-daemon/src/ssh-codex-transport.js";

test("method access is bridge admission, validated and compatible with legacy Servers", () => {
  assert.equal(allowsAppServerMethod(undefined, "thread/queue/add"), true);
  assert.equal(parseAppServerMethodAccess({ version: 1, methods: [null] }), null);
  assert.equal(allowsAppServerMethod({ [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 2, methods: [] } }, "thread/resume"), false);
  assert.deepEqual(parseAppServerMethodAccess({ version: 1, methods: ["thread/resume", "thread/resume"] })?.methods, ["thread/resume"]);
});

test("native projection preserves upstream metadata and history but not local stores or connection handles", () => {
  const upstream = { platform: "linux", capabilities: { nativeFlag: true, extensions: {
    "opencraft/resume-history": { version: 1, mode: "paginated" },
    "opencraft/thread-queue": { version: 2, atomicSteer: true },
    "opencraft/attachment-staging": { version: 1 },
    "opencraft/host-capabilities": { version: 1 },
    "upstream/metadata": { version: 1 },
  } } };
  const projected = projectSharedNativeCodexInitialize(upstream) as any;
  assert.equal(projected.capabilities.nativeFlag, true);
  assert.deepEqual(projected.capabilities.extensions["opencraft/resume-history"], upstream.capabilities.extensions["opencraft/resume-history"]);
  assert.deepEqual(projected.capabilities.extensions["upstream/metadata"], { version: 1 });
  assert.equal(projected.capabilities.extensions["opencraft/thread-queue"], undefined);
  assert.equal(projected.capabilities.extensions["opencraft/host-capabilities"], undefined);
  assert.equal(projected.capabilities.extensions["opencraft/attachment-staging"], undefined);
  assert.ok(upstream.capabilities.extensions["opencraft/thread-queue"], "projection must not mutate upstream data");
  for (const method of CODEX_NATIVE_SHARED_METHODS) assert.equal(allowsAppServerMethod(projected.capabilities.extensions, method), true);
  for (const method of ["thread/queue/add", "fs/watch", "process/spawn", "attachment/stage"])
    assert.equal(allowsAppServerMethod(projected.capabilities.extensions, method), false);
});

test("actual SSH transport + shared broker + Runtime restores paginated items, older history and reload without queue adoption", async () => {
  const calls: string[] = [];
  const adapter = new CodexEngineAdapter({ kind: "remote", logDiagnostic: () => undefined,
    transport: new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture",
      knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" },
      spawnSsh: (args, env) => {
        const child = spawn(process.execPath, [new URL("./fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], {
          stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...env, FIXTURE_WORKBENCH_UI: "1" },
        });
        child.on("message", (frame: any) => calls.push(frame.method));
        return child;
      },
    }) });
  const clientId = "native-surface-fixture";
  const runtime = createAppServerWorkbenchRuntime({ hostId: "ssh:fixture", hostKind: "remote-ssh", autoReconnect: false,
    requestTimeoutMs: 2_000, transport: {
      get status() { return adapter.status; },
      connect: signal => adapter.connect(signal),
      send: frame => adapter.send(stampLogicalClientFrame(frame, clientId)),
      subscribeMessage: listener => adapter.subscribeMessage(frame => {
        const routed = routeLogicalClientFrame(frame, [clientId]);
        if (routed !== null) listener(routed);
      }),
      subscribeStatus: listener => adapter.subscribeStatus(listener),
      close: () => adapter.close(),
    } });
  try {
    await runtime.connect();
    assert.equal(runtime.resources.host.canRequest?.("thread/turns/list"), true);
    assert.equal(runtime.resources.host.canRequest?.("thread/queue/add"), false);
    assert.deepEqual(runtime.resources.threads.capabilities?.(), { fork: true, rename: true, archive: true, delete: false, pin: false });
    assert.equal(runtime.resources.attachments.capabilities(), null);
    assert.equal(runtime.resources.goals.capability(), null);
    await runtime.resources.composerCatalog.listSkills();
    await runtime.resources.composerCatalog.writeNewThreadDefaults({ model: "fixture-model", effort: "medium" });
    await assert.rejects(runtime.resources.fileSystem.watch("/remote", () => {}), /暂不支持/);
    assert.throws(() => runtime.resources.composerCatalog.createFuzzyFileSearchSession({ roots: ["/remote"] }), /暂不支持/);
    const lease = await runtime.acquireThread("ssh-ui-thread");
    try {
      await lease.retryRestore();
      assert.equal(lease.getSnapshot().authoritative, true);
      assert.equal(lease.getSnapshot().error, null);
      assert.match(JSON.stringify(lease.getSnapshot().timeline), /Historical remote answer/);
      assert.ok(calls.includes("thread/turns/list") && calls.includes("thread/items/list"));
      await lease.loadOlder();
      const timeline = JSON.stringify(lease.getSnapshot().timeline);
      assert.match(timeline, /Older remote answer/);
      assert.ok(timeline.indexOf("Older remote answer") < timeline.indexOf("Historical remote answer"));
      const composer = createComposerController(
        { type: "enqueue-follow-up", key: createConversationKey("ssh:fixture", "ssh-ui-thread") },
        { now: () => 1, createId: () => "kept-draft" },
      );
      composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Keep this draft" }] }] } });
      const before = lease.getSnapshot().queuedSubmissions.length;
      await assert.rejects(lease.submit(composer.createSubmitIntent()), /暂不支持/);
      assert.equal(lease.getSnapshot().queuedSubmissions.length, before);
      assert.equal(composer.getSnapshot().canSubmit, true);
      assert.ok(!calls.some(method => method.startsWith("thread/queue/")), "no unsupported background read or mutation crosses the bridge");
      await lease.retryRestore();
      assert.equal(lease.getSnapshot().authoritative, true);
      const frameIds = lease.getSnapshot().timeline.frames.map(frame => frame.id);
      assert.equal(new Set(frameIds).size, frameIds.length, "reload retains unique display segments, not one frame per Turn");
      assert.equal(JSON.stringify(lease.getSnapshot().timeline).split("Historical remote answer").length - 1, 1);
    } finally { lease.release(); }
  } finally { await runtime.dispose(); }
});
