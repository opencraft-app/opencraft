import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCraftMessageSenders } from "../../apps/opencraft-daemon/src/opencraft-message-senders.js";
import { allowsAppServerMethod, OPENCRAFT_METHOD_ACCESS_EXTENSION, parseAppServerMethodAccess } from "@opencraft/appserver-protocol";
import { routeLogicalClientFrame, stampLogicalClientFrame } from "@opencraft/app-host-protocol";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { CODEX_NATIVE_SHARED_METHODS, discoverNativeCodexGoalCapability, projectSharedNativeCodexInitialize } from "../../apps/opencraft-daemon/src/codex-native-surface.js";
import { SshCodexTransport } from "../../apps/opencraft-daemon/src/ssh-codex-transport.js";

test("method access is bridge admission, validated and compatible with legacy Servers", () => {
  assert.equal(allowsAppServerMethod(undefined, "thread/queue/add"), true);
  assert.equal(parseAppServerMethodAccess({ version: 1, methods: [null] }), null);
  assert.equal(allowsAppServerMethod({ [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 2, methods: [] } }, "thread/resume"), false);
  assert.deepEqual(parseAppServerMethodAccess({ version: 1, methods: ["thread/resume", "thread/resume"] })?.methods, ["thread/resume"]);
});

test("native Goal discovery uses the enabled feature catalog and preserves explicit read-only support", async () => {
  const writable = await discoverNativeCodexGoalCapability({}, async (method, params) => {
    assert.equal(method, "experimentalFeature/list");
    assert.deepEqual(params, {});
    return { data: [{ name: "goals", enabled: true }], nextCursor: null };
  });
  assert.deepEqual(writable, { version: 1, read: true, write: true });
  const projected = projectSharedNativeCodexInitialize({}, writable) as any;
  for (const method of ["thread/goal/get", "thread/goal/set", "thread/goal/clear"])
    assert.equal(allowsAppServerMethod(projected.capabilities.extensions, method), true);
  for (const catalog of [{ data: [{ name: "goals", enabled: false }] }, { data: [] }, { echo: {} }, { data: [{ name: "goals", enabled: "true" }] }])
    assert.equal(await discoverNativeCodexGoalCapability({}, async () => catalog), null);
  const readOnly = { version: 1 as const, read: true as const, write: false };
  const explicit = { capabilities: { extensions: { "opencraft/thread-goal": readOnly } } };
  const capability = await discoverNativeCodexGoalCapability(explicit, async () => { throw new Error("must not probe an explicit capability"); });
  assert.deepEqual(capability, readOnly);
  const readonlyProjection = projectSharedNativeCodexInitialize(explicit, capability) as any;
  assert.equal(allowsAppServerMethod(readonlyProjection.capabilities.extensions, "thread/goal/get"), true);
  assert.equal(allowsAppServerMethod(readonlyProjection.capabilities.extensions, "thread/goal/set"), false);
  assert.equal(allowsAppServerMethod(readonlyProjection.capabilities.extensions, "thread/goal/clear"), false);
});

for (const mode of ["enabled", "disabled", "unsupported"] as const) {
  test(`SSH native Goal ${mode}: Runtime discovers existing state without starting a continuation`, async () => {
    const calls: string[] = [];
    const adapter = new CodexEngineAdapter({ kind: "remote", logDiagnostic: () => undefined, transport: new SshCodexTransport({
      hostname: "fixture.invalid", username: "fixture", port: 22, knownHostsFile: "/synthetic/known_hosts",
      authentication: { kind: "agent" }, spawnSsh: (args, env) => {
        const child = spawn(process.execPath, [new URL("../fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], {
          stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...env, FIXTURE_WORKBENCH_UI: "1", FIXTURE_NATIVE_GOALS: mode },
        });
        child.on("message", (frame: any) => calls.push(frame.method));
        return child;
      },
    }) });
    const clientId = `native-goal-${mode}`;
    const runtime = createAppServerWorkbenchRuntime({ hostId: "ssh:fixture", hostKind: "remote-ssh", autoReconnect: false,
      requestTimeoutMs: 2_000, transport: {
        get status() { return adapter.status; }, connect: signal => adapter.connect(signal),
        send: frame => adapter.send(stampLogicalClientFrame(frame, clientId)),
        subscribeMessage: listener => adapter.subscribeMessage(frame => {
          const routed = routeLogicalClientFrame(frame, [clientId]);
          if (routed !== null) listener(routed);
        }), subscribeStatus: listener => adapter.subscribeStatus(listener), close: () => adapter.close(),
      } });
    try {
      await runtime.connect();
      // The fixture reports calls through IPC independently of the stdout RPC reply.
      for (let attempt = 0; !calls.includes("experimentalFeature/list") && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(calls.filter(method => method === "experimentalFeature/list").length, 1);
      if (mode !== "enabled") {
        assert.equal(runtime.resources.goals.capability(), null);
        assert.equal(runtime.resources.host.canRequest?.("thread/goal/get"), false);
        const skills = await runtime.resources.composerCatalog.listSkills();
        assert.ok(skills);
        return;
      }
      assert.deepEqual(runtime.resources.goals.capability(), { version: 1, read: true, write: true });
      await runtime.resources.goals.refresh("ssh-ui-thread");
      assert.equal(runtime.resources.goals.getSnapshot("ssh-ui-thread").goal?.objective, "Existing remote goal");
      assert.equal(runtime.resources.goals.getSnapshot("ssh-ui-thread").goal?.tokensUsed, 731);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.ok(!calls.includes("thread/goal/set") && !calls.includes("turn/start") && !calls.includes("thread/resume"));
      await runtime.resources.goals.set("ssh-ui-thread", { status: "paused" });
      assert.equal(runtime.resources.goals.getSnapshot("ssh-ui-thread").goal?.status, "paused");
      await runtime.resources.goals.clear("ssh-ui-thread");
      assert.equal(runtime.resources.goals.getSnapshot("ssh-ui-thread").goal, null);
      assert.ok(!calls.includes("thread/queue/add"));
    } finally { await runtime.dispose(); }
  });
}

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
        const child = spawn(process.execPath, [new URL("../fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], {
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
    assert.equal(runtime.resources.host.canRequest?.("thread/search"), true);
    const body = await runtime.resources.protocol.request("thread/search", { searchTerm: "Historical", limit: 1 });
    assert.equal(body.data[0]?.snippet, "Historical remote answer");
    const occurrence = await runtime.resources.protocol.request("thread/searchOccurrences", { threadId: body.data[0]!.thread.id, searchTerm: "Historical", limit: 1 });
    assert.equal(occurrence.data[0]?.itemId, "fixture-answer");
    assert.ok(!calls.includes("thread/resume"), "search must not resume a thread");
    assert.equal(runtime.resources.host.canRequest?.("thread/turns/list"), true);
    assert.equal(runtime.resources.host.canRequest?.("thread/queue/add"), false);
    const nativeCapabilities = runtime.resources.threads.capabilities?.();
    assert.ok(nativeCapabilities);
    if ("reference" in nativeCapabilities) assert.equal(nativeCapabilities.reference, false);
    const lifecycleCapabilities = Object.fromEntries(Object.entries(nativeCapabilities).filter(([name]) => name !== "reference"));
    assert.deepEqual(lifecycleCapabilities, { fork: true, rename: true, archive: true, delete: false, pin: false });
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
