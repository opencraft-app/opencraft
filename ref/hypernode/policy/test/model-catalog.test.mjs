import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DashboardService } from "../src/services/dashboard.ts";
import { modelMetadata } from "../src/generated/model-metadata.ts";
import { ModelCatalogService } from "../src/services/model-catalog.ts";
import { ModelGatewayService } from "../src/services/model-gateway.js";
import { ModelMetadataService } from "../src/services/model-metadata.ts";
import { effectiveRequestedModel } from "../src/services/model-route.ts";

test("custom execution catalogs contain private and public models but no Codex subscription models", () => {
  const service = Object.create(ModelCatalogService.prototype);
  const active = {
    providerId: "private-a", displayName: "Private A", endpoint: "https://private/a",
    model: "private-model-a", visibility: "private",
  };
  service.ctx = { modelMetadata: {
    inputModalitiesForRecord: (record) => (
      record.inputModalities ?? (record.model === "public-model-a" ? ["text", "image"] : ["text"])
    ),
  }, modelGateway: {
    activeForConnection: () => active,
    visibleRecordsForUser: () => [
      active,
      { providerId: "private-b", displayName: "Private B", endpoint: "https://private/b", model: "private-model-b", visibility: "private" },
      { providerId: "public-a", displayName: "Public A", endpoint: "https://public/a", model: "public-model-a", visibility: "public" },
    ],
  } };
  const connection = { identity: { id: "user:alice" } };
  const models = service.forConnection(connection);
  assert.deepEqual(models.map((model) => model.id), [
    "private-model-a", "private-model-b", "public-model-a",
  ]);
  assert.equal(models.some((model) => model.id === "gpt-5.6-sol"), false);
  assert.equal(models[0].isDefault, true);
  assert.match(models[2].description, /^Public model/);
  assert.deepEqual(models[2].inputModalities, ["text", "image"]);
  assert.deepEqual(service.list({ cursor: "1", limit: 1 }, connection), {
    data: [models[1]], nextCursor: "2",
  });
});

test("subscription catalogs append private and public models with a stable pagination cursor", () => {
  const service = Object.create(ModelCatalogService.prototype);
  const connection = { identity: { id: "user:alice" } };
  service.ctx = { modelMetadata: { inputModalitiesForRecord: () => ["text"] }, modelGateway: { visibleRecordsForUser: () => [
    { providerId: "private-a", displayName: "Private A", endpoint: "https://private/a", model: "private-a", visibility: "private" },
    { providerId: "public-a", displayName: "Public A", endpoint: "https://public/a", model: "public-a", visibility: "public" },
  ] } };
  assert.deepEqual(service.mergeSubscriptionPage({
    data: [{ id: "codex-a", model: "codex-a" }], nextCursor: null,
  }, { limit: 2 }, connection), {
    data: [{ id: "codex-a", model: "codex-a" }, service.customModels(connection)[0]],
    nextCursor: "hypernode-public:1",
  });
  assert.deepEqual(service.customPage({ cursor: "hypernode-public:1", limit: 2 }, connection), {
    data: [service.customModels(connection)[1]], nextCursor: null,
  });
});

test("generated model metadata exposes native vision capabilities", () => {
  const service = Object.create(ModelMetadataService.prototype);
  service.byRoute = new Map();
  service.byModel = new Map();
  for (const record of modelMetadata) {
    service.byRoute.set(`${record.provider}\0${record.id}`, record);
    const records = service.byModel.get(record.id) ?? [];
    records.push(record);
    service.byModel.set(record.id, records);
  }
  assert.equal(service.supportsInput("kimi-k2.6", "image"), true);
  assert.equal(service.supportsInput("glm-5", "image"), false);
  assert.deepEqual(service.inputModalitiesForRecord({
    model: "opaque-provider-id", inputModalities: ["text", "image"],
  }), ["text", "image"]);
});

test("the public model dashboard action is administrator-only", () => {
  const dashboard = Object.create(DashboardService.prototype);
  dashboard.forms = new Map();
  dashboard.register({
    id: "public", fields: [], visible: (user) => user.role === "administrator",
    submit: () => ({ ok: true }),
  });
  assert.equal(dashboard.describe({ role: "member" }).length, 0);
  assert.equal(dashboard.describe({ role: "administrator" }).length, 1);
  assert.throws(() => dashboard.submit({ role: "member" }, "public", {}), /not available/);
  assert.deepEqual(dashboard.submit({ role: "administrator" }, "public", {}), { ok: true });
});

test("an administrator can configure multiple public models at one endpoint", (t) => {
  const previous = globalThis.hostModelGateway;
  const previousSha256 = globalThis.crypto.sha256;
  const registered = [];
  globalThis.crypto.sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
  globalThis.hostModelGateway = {
    available: true,
    registerProvider: (id, endpoint) => registered.push([id, endpoint]),
    removeUserProvider: () => {},
  };
  t.after(() => {
    globalThis.hostModelGateway = previous;
    if (previousSha256 === undefined) delete globalThis.crypto.sha256;
    else globalThis.crypto.sha256 = previousSha256;
  });
  const service = Object.create(ModelGatewayService.prototype);
  service.ctx = { storage: { available: false }, userDirectory: { list: () => [] } };
  service.fallbackPublic = [];
  service.publicCredentials = new Map();
  const admin = { id: "user:admin", role: "administrator" };
  const first = service.configurePublicForUser(admin, {
    endpoint: "https://models.example/v1/chat/completions", apiKey: "secret-a",
    model: "model-a", name: "Model A", inputModalities: "text,image",
  });
  const second = service.configurePublicForUser(admin, {
    endpoint: "https://models.example/v1/chat/completions", apiKey: "secret-b",
    model: "model-b", name: "Model B",
  });
  const dotted = service.configurePublicForUser(admin, {
    endpoint: "https://models.example/plan/v3/chat/completions", apiKey: "secret-c",
    model: "glm-5.3", name: "GLM 5.3", id: "tokenhub-glm-5.3",
  });
  assert.notEqual(first.provider.id, second.provider.id);
  assert.deepEqual(first.provider.inputModalities, ["text", "image"]);
  assert.equal(dotted.provider.id, "hypernode-public-tokenhub-glm-5-3");
  assert.deepEqual(service.publicRecords().map((record) => record.model), ["model-a", "model-b", "glm-5.3"]);
  assert.equal(service.publicCredentials.size, 3);
  assert.equal(registered.length, 3);
  assert.throws(() => service.configurePublicForUser({ role: "member" }, {
    endpoint: "https://models.example", apiKey: "x", model: "model-c",
  }), /administrator/);
});

test("persisted public credentials are restored for every configured provider", () => {
  const service = Object.create(ModelGatewayService.prototype);
  service.publicCredentials = new Map();
  service.ctx = { storage: { available: true, sql: { exec: (sql) => {
    assert.match(sql, /SELECT provider_id, api_key/);
    return { toArray: () => [
      { provider_id: "public-a", api_key: "secret-a" },
      { provider_id: "public-b", api_key: "secret-b" },
    ] };
  } } } };
  service.restorePublicCredentials();
  assert.equal(service.publicCredentials.get("public-a"), "secret-a");
  assert.equal(service.publicCredentials.get("public-b"), "secret-b");
});

test("persisted public selections are activated before Codex runtimes start", (t) => {
  const previous = globalThis.hostModelGateway;
  const configured = [];
  globalThis.hostModelGateway = {
    available: true,
    configureUser: (...args) => configured.push(args),
  };
  t.after(() => { globalThis.hostModelGateway = previous; });
  const service = Object.create(ModelGatewayService.prototype);
  const alice = {
    id: "user:alice", username: "alice", linuxUid: 20001, linuxGid: 20001,
    installationId: "installation-alice",
  };
  service.ctx = { userDirectory: { list: () => [alice] } };
  service.publicCredentials = new Map([["public-a", "secret-a"]]);
  service.selectionForUser = () => ({ kind: "public", profileId: "public-a" });
  service.publicRecords = () => [{
    providerId: "public-a", endpoint: "https://public.example/v1/chat/completions",
    model: "model-a", displayName: "Model A", visibility: "public",
  }];
  service.restorePublicSelections();
  assert.equal(configured.length, 1);
  assert.deepEqual(configured[0], [
    "alice", 20001, 20001, "installation-alice", "public-a",
    "https://public.example/v1/chat/completions", "secret-a", "model-a", "Model A",
  ]);
});

test("an unconfigured user defaults to the public auto provider route", () => {
  const service = Object.create(ModelGatewayService.prototype);
  service.ctx = { storage: { available: false } };
  service.fallbackSelections = new Map();
  service.recordsForUser = () => [];
  service.publicRecords = () => [
    { providerId: "public-k3", model: "kimi-k3" },
    { providerId: "public-auto", model: "auto" },
  ];

  assert.deepEqual(service.selectionForUser("user:new"), {
    kind: "public",
    profileId: "public-auto",
  });
  assert.equal(service.activeForUser("user:new").providerId, "public-auto");
});

test("an explicit user selection is never replaced by the public default", () => {
  const service = Object.create(ModelGatewayService.prototype);
  service.ctx = { storage: { available: false } };
  service.fallbackSelections = new Map([[
    "user:bound",
    { kind: "codex", profileId: "subscription-a" },
  ]]);
  service.recordsForUser = () => [];
  service.publicRecords = () => [{ providerId: "public-auto", model: "auto" }];

  assert.deepEqual(service.selectionForUser("user:bound"), {
    kind: "codex",
    profileId: "subscription-a",
  });
});

test("opening a public-model thread materializes its provider for the current executor", (t) => {
  const previous = globalThis.hostModelGateway;
  const configured = [];
  globalThis.hostModelGateway = {
    credentialLoaded: () => false,
    configureUser: (...args) => configured.push(args),
  };
  t.after(() => { globalThis.hostModelGateway = previous; });
  const service = Object.create(ModelGatewayService.prototype);
  const user = {
    id: "user:bob", username: "bob", linuxUid: 20002, linuxGid: 20002,
    installationId: "installation-bob",
  };
  const record = {
    providerId: "hypernode-public-kimi-k3",
    endpoint: "https://public.example/v1/chat/completions",
    model: "kimi-k3",
    displayName: "Kimi K3",
    visibility: "public",
  };
  service.ctx = { userDirectory: { find: (id) => id === user.id ? user : null } };
  service.recordsForUser = () => [];
  service.publicRecords = () => [record];
  service.publicCredentials = new Map([[record.providerId, "platform-secret"]]);

  assert.equal(service.ensureRuntimeProvider(user.id, record.providerId), record);
  assert.deepEqual(configured[0], [
    "bob", 20002, 20002, "installation-bob", record.providerId,
    record.endpoint, "platform-secret", record.model, record.displayName,
  ]);
});

test("model routing follows the requested model independently of the current execution profile", (t) => {
  const service = Object.create(ModelGatewayService.prototype);
  const user = { id: "user:alice" };
  const privateRecord = { providerId: "private", model: "private-model", visibility: "private" };
  const publicRecord = {
    providerId: "public", model: "public-model", displayName: "Public Model", visibility: "public",
  };
  service.currentUser = () => user;
  service.codexProfileSource = { list: () => [] };
  service.recordsForUser = () => [privateRecord];
  service.publicRecords = () => [publicRecord];
  service.activeForUser = () => privateRecord;
  service.selectForUser = assert.fail;
  service.publicCredentials = new Map([["public", "secret"]]);
  const previous = globalThis.hostModelGateway;
  t.after(() => { globalThis.hostModelGateway = previous; });
  globalThis.hostModelGateway = {
    credentialLoaded: () => true,
  };
  service.selectPublicForUser = assert.fail;
  service.selectForUser = assert.fail;
  const routed = service.selectModelForConnection({}, "public-model");
  assert.equal(routed.provider.id, "public");
  assert.equal(routed.provider.visibility, "public");
  service.activeForUser = () => null;
  assert.equal(service.selectModelForConnection({}, "public").provider.id, "public");
  assert.equal(service.selectModelForConnection({}, "Public Model").provider.id, "public");
  assert.equal(service.selectModelForConnection({}, "native-codex-model"), null);
});

test("a bound subscription can override a public default for one native Codex turn", (t) => {
  const service = Object.create(ModelGatewayService.prototype);
  const user = { id: "user:alice", username: "alice" };
  const publicRecord = {
    providerId: "public", model: "public-model", displayName: "Public Model", visibility: "public",
  };
  service.currentUser = () => user;
  service.recordsForUser = () => [];
  service.publicRecords = () => [publicRecord];
  service.activeForUser = () => publicRecord;
  service.codexProfileSource = { list: () => [{ id: "subscription-a", name: "ChatGPT Plus" }] };
  service.publicCredentials = new Map([["public", "secret"]]);
  const previous = globalThis.hostModelGateway;
  t.after(() => { globalThis.hostModelGateway = previous; });
  globalThis.hostModelGateway = { credentialLoaded: () => true };

  assert.deepEqual(service.selectModelForConnection({}, "gpt-5.3-codex-spark"), {
    kind: "codex",
    provider: null,
    runtimeRefresh: { retired: 0, deferred: 0 },
  });
  assert.equal(service.selectModelForConnection({}, "public-model").kind, "dsh");
});

test("a node-shared subscription can route an unbound user to native Codex", (t) => {
  const service = Object.create(ModelGatewayService.prototype);
  const user = { id: "user:alice", username: "alice" };
  const publicRecord = {
    providerId: "public", model: "public-model", displayName: "Public Model", visibility: "public",
  };
  service.currentUser = () => user;
  const collidingPrivate = {
    providerId: "private-shawn",
    model: "gpt-5.6-sol",
    displayName: "shawn",
    visibility: "private",
  };
  service.recordsForUser = () => [collidingPrivate];
  service.publicRecords = () => [publicRecord];
  service.activeForUser = () => publicRecord;
  service.codexProfileSource = { list: () => [] };
  service.codexFallbackSource = { available: () => true };
  service.publicCredentials = new Map([["public", "secret"]]);
  const previous = globalThis.hostModelGateway;
  t.after(() => { globalThis.hostModelGateway = previous; });
  globalThis.hostModelGateway = { credentialLoaded: () => true };

  assert.deepEqual(service.selectModelForConnection({}, "gpt-5.6-sol"), {
    kind: "codex",
    provider: null,
    runtimeRefresh: { retired: 0, deferred: 0 },
  });
  assert.equal(service.selectModelForConnection({}, "public-model").kind, "dsh");
  assert.equal(service.selectModelForConnection({}, "private-shawn").provider.id, "private-shawn");
  assert.equal(service.selectModelForConnection({}, "shawn").provider.id, "private-shawn");
});

test("turn model routing follows Desktop collaboration settings and then the durable Thread route", () => {
  assert.equal(effectiveRequestedModel({
    model: null,
    collaborationMode: { mode: "default", settings: { model: "ep-xodwa4gc" } },
  }, { providerId: "older-provider" }), "ep-xodwa4gc");
  assert.equal(effectiveRequestedModel({ model: "explicit-model" }, {
    providerId: "older-provider",
  }), "explicit-model");
  assert.equal(effectiveRequestedModel({ model: null }, {
    providerId: "hypernode-public-kimi-k3",
  }), "hypernode-public-kimi-k3");
});
