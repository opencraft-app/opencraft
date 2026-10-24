import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository";
import { SpeechModelConfiguration, HUNYUAN_SPEECH } from "../../apps/local-agent-host/src/model-config/speech";
import { migrateSpeechEnvironment } from "../../apps/local-agent-host/src/model-config/migrate-speech";
import { DshModelConfigurationBridge, DshModelEngineAdapter } from "../../apps/local-agent-host/src/model-config/dsh-adapter";
import { ModelConfigurationService } from "../../apps/local-agent-host/src/model-config/service";
import { RuntimeProviderService } from "../../apps/local-agent-host/src/runtime-provider-service";
import { SpeechTranscriptionService } from "../../scripts/speech-transcription-service.mjs";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
import { encodeSpeechWav } from "../../plugins/voice-input/src/audio-capture";
import { CloudSpeechInputProvider, SpeechServiceClient } from "../../plugins/voice-input/src/cloud-speech";
import type { DshClient } from "../../apps/local-agent-host/src/dsh-client";

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "opencraft-speech-models-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = new ModelConfigurationRepository(dir), credentials = new ModelCredentialRepository(dir);
  const configuration = new SpeechModelConfiguration(repository, credentials);
  await repository.initialize();
  return { dir, repository, credentials, configuration };
}
const legacy = { OPENCRAFT_SPEECH_API_KEY: "synthetic-speech-secret", OPENCRAFT_SPEECH_MODEL: "ep-hyasr3" };
const audio = () => encodeSpeechWav([new Float32Array(16_000).fill(0.1)], 16_000);

test("explicit migration shares the model credential repository, is idempotent and never overrides a chat default", async t => {
  const f = await fixture(t);
  await f.credentials.set("CHAT_KEY", "synthetic-chat-key");
  await f.repository.update(0, doc => {
    doc.providers.push({ id: "chat", name: "Chat", enabled: true, protocol: "openai-completions", baseUrl: "https://example.invalid/v1",
      credentialRef: "CHAT_KEY", models: [{ id: "text", enabled: true }] });
    doc.defaultModel = { providerId: "chat", modelId: "text" };
  });
  assert.deepEqual(await migrateSpeechEnvironment(f.repository, f.credentials, legacy), { migrated: true });
  const doc = await f.repository.read(), speech = doc.providers.find(p => p.protocol === "hunyuan-asr")!;
  assert.equal(await f.credentials.resolve(speech.credentialRef!), legacy.OPENCRAFT_SPEECH_API_KEY);
  assert.deepEqual(doc.defaultModel, { providerId: "chat", modelId: "text" });
  assert.deepEqual(doc.defaultSpeechModel, { providerId: speech.id, modelId: "ep-hyasr3" });
  assert.doesNotMatch(await readFile(f.repository.path, "utf8"), /synthetic-speech-secret|apiKeyEnv/);
  assert.deepEqual(await migrateSpeechEnvironment(f.repository, f.credentials, { ...legacy, OPENCRAFT_SPEECH_API_KEY: "another-secret" }), { migrated: false });
  assert.deepEqual(await f.repository.read(), doc);
  await assert.rejects(f.repository.update(doc.revision, draft => { draft.defaultModel = draft.defaultSpeechModel!; }), /聊天/);
  await assert.rejects(f.configuration.select(doc.revision, { providerId: "chat", modelId: "text" }));
});

test("binding pins selected model and credential only; CAS changes cannot silently redirect old audio", async t => {
  const f = await fixture(t); await migrateSpeechEnvironment(f.repository, f.credentials, legacy);
  const first = await f.configuration.read(); assert.ok(first.binding); assert.ok(first.config);
  await f.repository.update(first.revision, doc => { doc.providers[0]!.name = "改名"; });
  assert.equal((await f.configuration.read()).binding, first.binding, "a display rename cannot retire recording");
  await f.credentials.set("UNRELATED_CHAT_KEY", "synthetic-chat-rotation");
  assert.equal((await f.configuration.read()).binding, first.binding, "unrelated credential changes do not retire recording");
  const doc = await f.repository.read(); await f.credentials.set(doc.providers[0]!.credentialRef!, "rotated-synthetic-key");
  assert.notEqual((await f.configuration.read()).binding, first.binding);
  await assert.rejects(f.configuration.select(first.revision, null), /其他窗口/);
  await f.repository.update(doc.revision, draft => { draft.providers[0]!.enabled = false; });
  assert.equal((await f.configuration.read()).config, null);
  assert.deepEqual((await f.configuration.read()).selection, first.selection, "retain unavailable intent");
  const disabled = await f.repository.read();
  await f.repository.update(disabled.revision, draft => { draft.providers = []; });
  assert.deepEqual((await f.configuration.read()).selection, first.selection);
  await f.configuration.select((await f.repository.read()).revision, null);
  assert.equal((await f.configuration.read()).selection, null);
});

test("speech provider uses normal provider commands but no profile/key crosses into chat engine, and chat edits retain speech records", async t => {
  const f = await fixture(t), calls: { method: string; payload: any }[] = [];
  const raw = { writable: true, hasDocument: true, namespaces: ["llm-pi-ai", "llm-deepseek", "agent-default-model"].map(ns => ({ ns, revision: 0, value: {}, base: {}, user: {}, secrets: [], applies: "live" })) };
  const engine = { call: async (method: string, payload: any = {}) => {
    calls.push({ method, payload });
    if (method === "settings.describe") return structuredClone(raw);
    if (method === "llm.providers") return { providers: [] };
    if (method === "llm.models") return { groups: [], failures: [] };
    if (method === "settings.mutate") return {};
    if (method.startsWith("credentials.")) return {};
    throw new Error(`Unexpected engine call ${method}`);
  } } as unknown as Pick<DshClient, "call">;
  const config = new ModelConfigurationService(f.repository, f.credentials, new DshModelEngineAdapter(engine));
  const bridge = new DshModelConfigurationBridge(engine, config); await bridge.initialize();
  const providers = new RuntimeProviderService(bridge, true);
  assert.equal((await new RuntimeProviderService(bridge).list()).creation?.speech, undefined, "an engine without an application ASR service must not advertise it");
  const creation = (await providers.list()).creation!; assert.deepEqual(creation.speech, HUNYUAN_SPEECH);
  await providers.apply({ target: { kind: "create", id: "custom-asr" }, expectedRevision: creation.revision,
    displayName: "混元连接", api: HUNYUAN_SPEECH.api, baseURL: HUNYUAN_SPEECH.baseURL,
    models: [{ id: "ep-hyasr3", type: "asr" }], enabled: true, credential: { kind: "replace", value: "synthetic-speech-secret" } });
  assert.equal(config.application.state, "applied");
  const declared = (await providers.models(true)).groups[0]!.models[0]!;
  assert.equal(declared.type, "asr"); assert.equal(declared.input, undefined); assert.equal(declared.source, "custom");
  assert.deepEqual((await providers.models()).groups, []);
  const speechProvider = (await providers.list()).providers.find(provider => provider.provider === "custom-asr");
  assert.ok(speechProvider);
  assert.equal(speechProvider.configuration?.canProbe, false); assert.equal(speechProvider.configuration?.modelType, "asr");
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-speech-secret|hunyuan-asr|ep-hyasr3|custom-asr/, "DSH receives no speech profile, model or secret");
  const rev = (await f.repository.read()).revision;
  await f.configuration.select(rev, { providerId: "custom-asr", modelId: "ep-hyasr3" });
  await providers.apply({ target: { kind: "create", id: "custom-chat" }, expectedRevision: rev + 1,
    displayName: "Chat", api: "openai-completions", baseURL: "https://example.invalid/v1", models: [{ id: "chat-model" }], credential: { kind: "none" }, enabled: false });
  const doc = await f.repository.read();
  assert.equal(doc.providers.find(p => p.id === "custom-asr")?.models[0]?.type, "asr");
  assert.deepEqual(doc.defaultSpeechModel, { providerId: "custom-asr", modelId: "ep-hyasr3" });
  await assert.rejects(providers.discover({ source: "catalog", provider: "custom-asr", settingsNs: "llm-pi-ai" }), /手动/);
  await assert.rejects(providers.apply({ target: { kind: "update", id: "custom-asr" }, expectedRevision: doc.revision,
    api: "hunyuan-asr", baseURL: "https://foreign.invalid", credential: { kind: "keep", allowEndpointChange: true } }), /语音连接/);
  await providers.setEnabled({ provider: "custom-asr", expectedRevision: doc.revision, enabled: false });
  assert.equal((await f.configuration.read()).config, null);
});

test("dynamic gateway reads shared config, refuses missing/stale binding before billing, dedupes concurrent attempts and redacts secrets", async t => {
  const f = await fixture(t); await writeFile(join(f.dir, "index.html"), "<!doctype html>");
  let calls = 0, release: (() => void) | undefined;
  const service = new SpeechTranscriptionService({ configuration: f.configuration, fetch: async (_url: unknown, init: RequestInit) => {
    calls++; assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-speech-secret");
    assert.equal(JSON.parse(String(init.body)).model, "ep-hyasr3");
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ status: "completed", output: { text: "测试" } });
  } });
  const server = await createWorkbenchWebServer({ root: f.dir, loopbackOnly: true, appServerTarget: null, speechService: service });
  t.after(() => server.close()); const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new SpeechServiceClient((url, init) => fetch(`${origin}${url}`, { ...init, headers: { ...init?.headers, ...(init?.method === "POST" ? { origin } : {}) } }));
  t.after(() => client.close()); await client.refresh(); assert.equal(client.getSnapshot().phase, "unavailable");
  await migrateSpeechEnvironment(f.repository, f.credentials, legacy); await client.refresh();
  const initial = client.getSnapshot(); assert.equal(initial.phase, "ready"); assert.ok(initial.binding);
  assert.doesNotMatch(JSON.stringify(await service.describe()), /synthetic-speech-secret|credentialRef/);
  const post = (binding?: string) => fetch(`${origin}/__opencraft_speech/transcribe`, { method: "POST", body: audio().blob,
    headers: { origin, "content-type": "audio/wav", "x-opencraft-speech-session": "session", "x-opencraft-speech-attempt": "attempt",
      ...(binding ? { "x-opencraft-speech-binding": binding } : {}) } });
  assert.equal((await post()).status, 400); assert.equal((await post("a".repeat(64))).status, 409); assert.equal(calls, 0);
  const pending = post(initial.binding!);
  for (let tries = 0; tries < 50 && calls === 0; tries++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal((await post(initial.binding!)).status, 409); assert.equal(calls, 1);
  release!(); assert.equal((await pending).status, 200); assert.equal((await post(initial.binding!)).status, 200); assert.equal(calls, 1);
  assert.equal((await post("b".repeat(64))).status, 409); assert.equal(calls, 1);
  const other = new SpeechModelConfiguration(f.repository, f.credentials);
  assert.notEqual((await other.read()).binding, initial.binding, "server replacement retires old capture");
  await client.selectModel(null); assert.equal(client.getSnapshot().phase, "unavailable");
  await client.selectModel(initial.selection); assert.equal(client.getSnapshot().phase, "ready");
  await f.repository.update((await f.repository.read()).revision, doc => { doc.providers[0]!.enabled = false; });
  await assert.rejects(client.selectModel(null), /更新/); await client.refresh();
  assert.deepEqual(client.getSnapshot().selection, initial.selection);
});

test("recording and explicit retry keep start binding despite later discovery changes; stale rejection never inserts text", async () => {
  const bindings: string[] = []; let binding = "a".repeat(64), calls = 0, retry!: () => void;
  const client = new SpeechServiceClient(async (url, init) => {
    if (url === "/__opencraft_speech/capabilities") return Response.json({ available: true, binding, provider: "hunyuan", maxDurationMs: 120_000, maxAudioBytes: 3_840_044 });
    bindings.push(new Headers(init!.headers).get("x-opencraft-speech-binding")!); calls++;
    return Response.json({ error: { code: calls === 1 ? "service-error" : "configuration-changed", retryable: calls === 1 } }, { status: calls === 1 ? 502 : 409 });
  });
  await client.refresh();
  const provider = new CloudSpeechInputProvider(client, { isAvailable: () => true, async start() { return { async stop() { return audio(); }, cancel() {} }; } });
  const events: unknown[] = [];
  const session = provider.start({ commit: text => events.push(text), end() {}, error: error => events.push(error.message), recover: (_error, action) => { retry = action; } });
  binding = "b".repeat(64); await client.refresh(); session.stop();
  await new Promise(resolve => setImmediate(resolve)); retry(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bindings, ["a".repeat(64), "a".repeat(64)]);
  assert.deepEqual(events, ["语音设置已改变，请重新录音"]);
  provider.close(); client.close();
});

test("migration CLI reads private source by path only, emits no key, and refuses permissive files/symlinks", async t => {
  const f = await fixture(t), source = join(f.dir, "legacy.env"), target = join(f.dir, "imported");
  await writeFile(source, `OPENCRAFT_SPEECH_API_KEY='${legacy.OPENCRAFT_SPEECH_API_KEY}'\nOPENCRAFT_SPEECH_MODEL=ep-hyasr3\nOPENCRAFT_SPEECH_PUBLIC_ACCESS=1\n`, { mode: 0o600 });
  const run = (path: string) => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/migrate-speech-models.ts", "--source", path, "--models", target]);
  const first = await run(source); assert.match(first.stdout, /已导入/); assert.doesNotMatch(first.stdout + first.stderr, /synthetic-speech-secret/);
  const again = await run(source); assert.match(again.stdout, /未重复/);
  assert.equal((await new ModelConfigurationRepository(target).read()).providers[0]?.models[0]?.type, "asr");
  await chmod(source, 0o644);
  await assert.rejects(run(source), (error: any) => !String(error.stdout + error.stderr).includes(legacy.OPENCRAFT_SPEECH_API_KEY));
  await chmod(source, 0o600); const link = join(f.dir, "link.env"); await symlink(source, link);
  await assert.rejects(run(link));
});

test("a legacy speech environment is not a runtime credential authority", async t => {
  const f = await fixture(t), prior = process.env.OPENCRAFT_SPEECH_API_KEY;
  process.env.OPENCRAFT_SPEECH_API_KEY = "synthetic-environment-key";
  t.after(() => { if (prior === undefined) delete process.env.OPENCRAFT_SPEECH_API_KEY; else process.env.OPENCRAFT_SPEECH_API_KEY = prior; });
  assert.equal((await f.configuration.read()).config, null);
  await writeFile(join(f.dir, "index.html"), "<!doctype html>");
  const server = await createWorkbenchWebServer({ root: f.dir, appServerTarget: null, loopbackOnly: true });
  t.after(() => server.close()); const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const value = await (await fetch(`http://127.0.0.1:${address.port}/__opencraft_speech/capabilities`)).json();
  assert.equal(value.available, false);
});
