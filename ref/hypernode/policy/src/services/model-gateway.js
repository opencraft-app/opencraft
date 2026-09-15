import { Service } from "@deepseek-ai/cordis";
import {
  modelProtocol,
  needsInternalFinishTool,
  needsResponseIdSanitization,
  normalizedModelEndpoint,
  normalizeChatCompletionsEndpoint,
} from "./model-provider-protocol.ts";

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function providerId(userId, endpoint, requested) {
  const explicit = String(requested ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-");
  if (explicit) return `hypernode-${crypto.sha256(userId).slice(0, 8)}-${explicit.slice(0, 40)}`;
  return `hypernode-${crypto.sha256(userId).slice(0, 8)}-${crypto.sha256(endpoint).slice(0, 12)}`;
}

function endpointHost(endpoint) {
  const match = String(endpoint).match(/^https?:\/\/([^/?#]+)/i);
  return match?.[1] ?? "custom endpoint";
}

const supportedInputModalities = new Set(["text", "image"]);

function inputModalities(value, fallback = null) {
  if (value == null || value === "") return fallback;
  let entries = value;
  if (typeof entries === "string") {
    const text = entries.trim();
    if (!text) return fallback;
    try { entries = JSON.parse(text); } catch { entries = text.split(","); }
  }
  if (!Array.isArray(entries)) throw new Error("input modalities must be a list");
  const normalized = [...new Set(entries.map((entry) => String(entry).trim()).filter(Boolean))];
  for (const modality of normalized) {
    if (!supportedInputModalities.has(modality)) {
      throw new Error(`unsupported input modality ${JSON.stringify(modality)}`);
    }
  }
  if (!normalized.includes("text")) normalized.unshift("text");
  return normalized;
}

function storedInputModalities(value) {
  const normalized = inputModalities(value, null);
  return normalized == null ? null : JSON.stringify(normalized);
}

export { normalizeChatCompletionsEndpoint };

function publicRecord(record, credentialLoaded = false) {
  return {
    id: record.providerId,
    name: record.displayName,
    endpoint: record.endpoint,
    model: record.model,
    active: record.active === true,
    credentialLoaded,
    configuredAtMs: record.configuredAtMs,
    updatedAtMs: record.updatedAtMs,
    visibility: record.visibility ?? "private",
    apiProtocol: modelProtocol(record),
    inputModalities: record.inputModalities ?? null,
  };
}

function publicProviderId(endpoint, model, requested) {
  const explicit = String(requested ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-");
  if (explicit) return `hypernode-public-${explicit.slice(0, 48)}`;
  return `hypernode-public-${crypto.sha256(`${endpoint}\0${model}`).slice(0, 20)}`;
}

function skillWords(input) {
  const text = (input ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.replaceAll("&#x20;", " "))
    .join(" ")
    .replace(/\[\$?models?\]\([^)]+\)/ig, " models ")
    .replace(/^\s*\$?(?:models?|model-providers?|model-gateway)\b/i, "")
    .trim();
  const words = [];
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    words.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"'])/g, "$1"));
  }
  return words;
}

function hasImageInput(input) {
  return (Array.isArray(input) ? input : []).some((item) => (
    item?.type === "image" || item?.type === "localImage"
  ));
}

const preferredVisionModels = ["kimi-k2.6", "kimi-k2.5"];

export class ModelGatewayService extends Service {
  constructor(ctx) {
    super(ctx, "modelGateway");
    this.fallback = new Map();
    this.fallbackSelections = new Map();
    this.fallbackPublic = [];
    this.publicCredentials = new Map();
    this.runtimeRetirer = null;
    this.codexProfileSource = null;
    this.codexFallbackSource = null;
    this.nativeCodexModels = new Set(["gpt-5.6-sol"]);
    this.ensureSchema();
    this.restorePublicCredentials();
    this.restoreRoutes();
    this.restorePublicSelections();
    ctx.effect(() => ctx.dashboard.register({
      id: "model-provider.configure",
      title: "自定义模型 Provider",
      description: "连接兼容 OpenAI Chat Completions 的模型服务。",
      submitLabel: "保存并启用",
      fields: [
        { id: "endpoint", label: "Endpoint", type: "url", required: true, placeholder: "https://provider.example/v1/chat/completions" },
        { id: "apiKey", label: "API Key", type: "password", required: true, sensitive: true, autocomplete: "off" },
        { id: "model", label: "模型", type: "text", required: false, placeholder: "provider-model-name" },
        { id: "name", label: "显示名称", type: "text", required: false, placeholder: "可选" },
        { id: "inputModalities", label: "输入能力", type: "select", required: true, options: [
          { value: "text", label: "仅文本" },
          { value: "text,image", label: "文本与图片" },
        ] },
        { id: "apiProtocol", label: "上游协议", type: "select", required: false, options: [
          { value: "openai-responses", label: "OpenAI Responses（原样转发）" },
          { value: "openai-completions", label: "Chat Completions（兼容转换）" },
        ] },
      ],
      submit: (user, values) => this.configureForUser(user, values),
    }));
    ctx.effect(() => ctx.dashboard.register({
      id: "public-model-provider.configure",
      title: "平台公共模型",
      description: "添加一个对所有 HyperNode 用户可见的公共模型。可重复提交以配置多个模型；API Key 持久化在仅 root 可读的 HyperNode SQLite 中。",
      submitLabel: "保存公共模型",
      visible: (user) => user?.role === "administrator",
      fields: [
        { id: "endpoint", label: "Endpoint", type: "url", required: true, placeholder: "https://provider.example/v1/chat/completions" },
        { id: "apiKey", label: "平台 API Key", type: "password", required: true, sensitive: true, autocomplete: "off" },
        { id: "model", label: "模型 ID", type: "text", required: true, placeholder: "provider-model-name" },
        { id: "name", label: "显示名称", type: "text", required: false, placeholder: "可选" },
        { id: "id", label: "Provider ID", type: "text", required: false, placeholder: "可选；留空自动生成" },
        { id: "inputModalities", label: "输入能力", type: "select", required: true, options: [
          { value: "text", label: "仅文本" },
          { value: "text,image", label: "文本与图片" },
        ] },
        { id: "apiProtocol", label: "上游协议", type: "select", required: false, options: [
          { value: "openai-responses", label: "OpenAI Responses（原样转发）" },
          { value: "openai-completions", label: "Chat Completions（兼容转换）" },
        ] },
      ],
      submit: (user, values) => this.configurePublicForUser(user, values),
    }));
    ctx.effect(() => ctx.dashboard.register({
      id: "execution-profile.select",
      title: "执行身份",
      description: "选择后续 Turn 使用 Codex 订阅或某个自定义 API。正在执行的 Turn 不会被中途切换。",
      submitLabel: "切换",
      fields: (user) => {
        const subscriptions = this.codexProfileSource?.list(user) ?? [];
        return [{
          id: "profile",
          label: "执行通道",
          type: "select",
          required: true,
          value: this.profileValueForUser(user.id),
          options: [
            ...(subscriptions.length === 0
              ? [{ value: "codex:default", label: "Codex 订阅 · 当前活动账户" }]
              : subscriptions.map((profile) => ({
                value: `codex:${profile.id}`,
                label: `Codex 订阅 · ${profile.name}`,
              }))),
            ...this.recordsForUser(user.id).map((record) => ({
              value: `api:${record.providerId}`,
              label: `自定义 API · ${record.displayName}`,
            })),
            ...this.publicRecords().map((record) => ({
              value: `public:${record.providerId}`,
              label: `公共模型 · ${record.displayName}`,
            })),
          ],
        }, {
          id: "apiKey",
          label: "API Key（该 Provider 的凭据尚未加载时填写）",
          type: "password",
          required: false,
          sensitive: true,
          autocomplete: "off",
        }];
      },
      submit: (user, values) => this.switchProfileForUser(user, values),
    }));
    ctx.effect(() => ctx.appServer.register("hypernode/modelProviders/list", (_params, connection) => ({
      providers: this.list(connection),
    })));
    ctx.effect(() => ctx.appServer.register("hypernode/modelProviders/configure", (params, connection) => (
      this.configure(connection, params)
    )));
    ctx.effect(() => ctx.appServer.register("hypernode/modelProviders/select", (params, connection) => (
      this.select(connection, params)
    )));
    ctx.effect(() => ctx.appServer.register("hypernode/modelProviders/remove", (params, connection) => (
      this.remove(connection, params)
    )));
    ctx.effect(() => ctx.appServer.register("hypernode/executionProfile/select", (params, connection) => (
      this.switchProfile(connection, params)
    )));
  }

  ensureSchema() {
    if (!this.ctx.storage.available) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_model_gateway_profiles (
        user_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        configured_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(user_id, provider_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_public_model_gateway_profiles (
        provider_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        configured_by_user_id TEXT NOT NULL,
        configured_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    const publicColumns = new Set(this.ctx.storage.sql.exec(
      "PRAGMA table_info(do_public_model_gateway_profiles)",
    ).toArray().map((row) => row.name));
    if (!publicColumns.has("api_key")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE do_public_model_gateway_profiles ADD COLUMN api_key TEXT",
      );
    }
    for (const table of ["do_model_gateway_profiles", "do_public_model_gateway_profiles"]) {
      const columns = new Set(this.ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => row.name));
      if (!columns.has("api_protocol")) {
        this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN api_protocol TEXT`);
      }
      if (!columns.has("input_modalities")) {
        this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN input_modalities TEXT`);
      }
    }
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS do_model_gateway_profiles_active
      ON do_model_gateway_profiles(user_id, active)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_execution_profile_selection (
        user_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  restorePublicCredentials() {
    if (!this.ctx.storage.available) return;
    const rows = this.ctx.storage.sql.exec(`
      SELECT provider_id, api_key
      FROM do_public_model_gateway_profiles
      WHERE api_key IS NOT NULL AND api_key <> ''
    `).toArray();
    for (const row of rows) this.publicCredentials.set(row.provider_id, row.api_key);
  }

  restoreRoutes() {
    if (!globalThis.hostModelGateway?.available) return;
    for (const record of [...this.allRecords(), ...this.publicRecords()]) {
      try {
        hostModelGateway.registerProvider(record.providerId, record.endpoint);
      } catch (error) {
        console.warn(`[model-gateway] failed to restore provider=${record.providerId}: ${error.message ?? error}`);
      }
    }
  }

  restorePublicSelections() {
    if (!globalThis.hostModelGateway?.available) return;
    for (const user of this.ctx.userDirectory.list()) {
      const selection = this.selectionForUser(user.id);
      if (selection.kind !== "public") continue;
      const record = this.publicRecords()
        .find((candidate) => candidate.providerId === selection.profileId);
      const apiKey = record ? this.publicCredentials.get(record.providerId) : null;
      if (!record || !apiKey) {
        console.warn(
          `[model-gateway] could not restore public selection user=${user.username} ` +
          `provider=${selection.profileId}: missing provider or API key`,
        );
        continue;
      }
      try {
        this.apply(user, record, apiKey);
      } catch (error) {
        console.warn(
          `[model-gateway] failed to restore public selection user=${user.username} ` +
          `provider=${record.providerId}: ${error.message ?? error}`,
        );
      }
    }
  }

  currentUser(connection) {
    const user = connection?.identity?.id
      ? this.ctx.userDirectory.find(connection.identity.id)
      : null;
    if (!user) throw new Error("model provider configuration requires an SSH user identity");
    return user;
  }

  allRecords() {
    if (!this.ctx.storage.available) return [...this.fallback.values()].flat();
    return this.ctx.storage.sql.exec(`
      SELECT user_id, provider_id, display_name, endpoint, model, active,
             configured_at_ms, updated_at_ms, api_protocol, input_modalities
      FROM do_model_gateway_profiles
      ORDER BY user_id, configured_at_ms, provider_id
    `).toArray().map((row) => this.fromRow(row));
  }

  recordsForUser(userId) {
    if (!this.ctx.storage.available) return [...(this.fallback.get(userId) ?? [])];
    return this.ctx.storage.sql.exec(`
      SELECT user_id, provider_id, display_name, endpoint, model, active,
             configured_at_ms, updated_at_ms, api_protocol, input_modalities
      FROM do_model_gateway_profiles
      WHERE user_id = ?
      ORDER BY active DESC, configured_at_ms, provider_id
    `, userId).toArray().map((row) => this.fromRow(row));
  }

  publicRecords() {
    if (!this.ctx.storage.available) return [...this.fallbackPublic];
    return this.ctx.storage.sql.exec(`
      SELECT provider_id, display_name, endpoint, model, configured_by_user_id,
             configured_at_ms, updated_at_ms, api_protocol, input_modalities
      FROM do_public_model_gateway_profiles
      ORDER BY configured_at_ms, provider_id
    `).toArray().map((row) => ({
      userId: row.configured_by_user_id,
      providerId: row.provider_id,
      displayName: row.display_name,
      endpoint: row.endpoint,
      model: row.model,
      active: false,
      visibility: "public",
      configuredAtMs: Number(row.configured_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      apiProtocol: row.api_protocol ?? null,
      inputModalities: inputModalities(row.input_modalities, null),
    }));
  }

  visibleRecordsForUser(userId) {
    return [...this.recordsForUser(userId), ...this.publicRecords()];
  }

  // Called by the Cordis-owned HTTP route multiplexed on port 9988. Provider ids are globally unique
  // routing capabilities; credentials remain request-scoped Authorization
  // headers and are never returned from this lookup.
  resolveGatewayRoute(providerId) {
    const record = [...this.allRecords(), ...this.publicRecords()]
      .find((candidate) => candidate.providerId === providerId);
    if (!record) return null;
    return {
      providerId: record.providerId,
      endpoint: normalizedModelEndpoint(record),
      model: record.model ?? null,
      visibility: record.visibility ?? "private",
      apiProtocol: modelProtocol(record),
      displayName: record.displayName,
      inputModalities: record.inputModalities ?? null,
      internalFinishTool: needsInternalFinishTool(record),
      sanitizeResponseIds: needsResponseIdSanitization(record),
    };
  }

  fromRow(row) {
    return {
      userId: row.user_id,
      providerId: row.provider_id,
      displayName: row.display_name,
      endpoint: row.endpoint,
      model: row.model ?? null,
      active: Number(row.active) === 1,
      configuredAtMs: Number(row.configured_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      apiProtocol: row.api_protocol ?? null,
      inputModalities: inputModalities(row.input_modalities, null),
    };
  }

  activeForUser(userId) {
    const selection = this.selectionForUser(userId);
    if (selection.kind === "api") {
      return this.recordsForUser(userId)
        .find((record) => record.providerId === selection.profileId) ?? null;
    }
    if (selection.kind === "public") {
      return this.publicRecords()
        .find((record) => record.providerId === selection.profileId) ?? null;
    }
    return null;
  }

  defaultPublicRecord() {
    const records = this.publicRecords();
    if (records.length === 0) return null;
    // "auto" is the platform router rather than one concrete model.  Prefer
    // it for unconfigured users so onboarding is provider-neutral; otherwise
    // use the oldest configured public route as the deterministic fallback.
    return records.find((record) => record.model === "auto") ?? records[0];
  }

  defaultSelection() {
    const provider = this.defaultPublicRecord();
    return provider
      ? { kind: "public", profileId: provider.providerId }
      : { kind: "codex", profileId: "default" };
  }

  activeForConnection(connection) {
    return connection?.identity?.id ? this.activeForUser(connection.identity.id) : null;
  }

  list(connection) {
    const user = this.currentUser(connection);
    const active = this.activeForUser(user.id)?.providerId ?? null;
    return this.visibleRecordsForUser(user.id).map((record) => publicRecord(
      { ...record, active: record.providerId === active },
      hostModelGateway?.credentialLoaded?.(user.username, record.providerId) === true,
    ));
  }

  selectionForUser(userId) {
    if (!this.ctx.storage.available) {
      return this.fallbackSelections.get(userId) ?? this.defaultSelection();
    }
    const row = this.ctx.storage.sql.exec(`
      SELECT kind, profile_id FROM do_execution_profile_selection WHERE user_id = ?
    `, userId).toArray()[0];
    if (row) return { kind: row.kind, profileId: row.profile_id };
    const legacy = this.recordsForUser(userId).find((record) => record.active);
    return legacy
      ? { kind: "api", profileId: legacy.providerId }
      : this.defaultSelection();
  }

  profileValueForUser(userId) {
    const selection = this.selectionForUser(userId);
    return `${selection.kind}:${selection.profileId}`;
  }

  setSelection(userId, kind, profileId) {
    const selection = { kind, profileId };
    if (!this.ctx.storage.available) {
      this.fallbackSelections.set(userId, selection);
      return selection;
    }
    this.ctx.storage.sql.exec(`
      INSERT INTO do_execution_profile_selection(user_id, kind, profile_id, updated_at_ms)
      VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        kind = excluded.kind,
        profile_id = excluded.profile_id,
        updated_at_ms = excluded.updated_at_ms
    `, userId, kind, profileId, Date.now());
    return selection;
  }

  configure(connection, params = {}) {
    if (!globalThis.hostModelGateway?.available) throw new Error("HyperNode model gateway is unavailable");
    return this.configureForUser(this.currentUser(connection), params);
  }

  configureForUser(user, params = {}) {
    if (!globalThis.hostModelGateway?.available) throw new Error("HyperNode model gateway is unavailable");
    const endpoint = requiredText(params.endpoint, "Chat Completions endpoint");
    const apiKey = requiredText(params.apiKey, "API key");
    const id = providerId(user.id, endpoint, params.id);
    const now = Date.now();
    const previous = this.recordsForUser(user.id).find((record) => record.providerId === id);
    const record = {
      userId: user.id,
      providerId: id,
      displayName: String(params.name ?? "").trim() || `Custom model (${endpointHost(endpoint)})`,
      endpoint,
      model: String(params.model ?? "").trim() || null,
      active: params.activate !== false,
      configuredAtMs: previous?.configuredAtMs ?? now,
      updatedAtMs: now,
      apiProtocol: String(params.apiProtocol ?? previous?.apiProtocol ?? "").trim() || null,
      inputModalities: inputModalities(params.inputModalities, previous?.inputModalities ?? null),
    };
    if (record.active) this.deactivateAll(user.id);
    this.save(record);
    if (record.active) {
      this.apply(user, record, apiKey);
      this.setSelection(user.id, "api", record.providerId);
    }
    else hostModelGateway.registerProvider(record.providerId, record.endpoint);
    return {
      provider: publicRecord(record, record.active),
      runtimeRefresh: record.active ? this.refreshUserRuntimes(user.id) : { retired: 0, deferred: 0 },
    };
  }

  configurePublicForUser(user, params = {}) {
    if (user?.role !== "administrator") throw new Error("only an administrator can configure public models");
    if (!globalThis.hostModelGateway?.available) throw new Error("HyperNode model gateway is unavailable");
    const endpoint = requiredText(params.endpoint, "Chat Completions endpoint");
    const apiKey = requiredText(params.apiKey, "API key");
    const model = requiredText(params.model, "model id");
    const id = publicProviderId(endpoint, model, params.id);
    const now = Date.now();
    const previous = this.publicRecords().find((record) => record.providerId === id);
    const collision = this.publicRecords().find((record) => record.model === model && record.providerId !== id);
    if (collision) throw new Error(`public model id ${JSON.stringify(model)} is already routed by ${collision.displayName}`);
    const record = {
      userId: user.id,
      providerId: id,
      displayName: String(params.name ?? "").trim() || `Public ${model}`,
      endpoint,
      model,
      active: false,
      visibility: "public",
      configuredAtMs: previous?.configuredAtMs ?? now,
      updatedAtMs: now,
      apiProtocol: String(params.apiProtocol ?? previous?.apiProtocol ?? "").trim() || null,
      inputModalities: inputModalities(params.inputModalities, previous?.inputModalities ?? null),
    };
    if (this.ctx.storage.available) {
      this.ctx.storage.sql.exec(`
        INSERT INTO do_public_model_gateway_profiles(
          provider_id, display_name, endpoint, model, api_key, configured_by_user_id,
          configured_at_ms, updated_at_ms, api_protocol, input_modalities
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider_id) DO UPDATE SET
          display_name = excluded.display_name,
          endpoint = excluded.endpoint,
          model = excluded.model,
          api_key = excluded.api_key,
          configured_by_user_id = excluded.configured_by_user_id,
          api_protocol = excluded.api_protocol,
          input_modalities = excluded.input_modalities,
          updated_at_ms = excluded.updated_at_ms
      `, record.providerId, record.displayName, record.endpoint, record.model, apiKey, record.userId,
      record.configuredAtMs, record.updatedAtMs, record.apiProtocol,
      storedInputModalities(record.inputModalities));
    } else {
      const index = this.fallbackPublic.findIndex((candidate) => candidate.providerId === id);
      if (index < 0) this.fallbackPublic.push(record);
      else this.fallbackPublic[index] = record;
    }
    hostModelGateway.registerProvider(record.providerId, record.endpoint);
    this.publicCredentials.set(record.providerId, apiKey);
    // Existing per-user copies may contain an older shared key. Invalidate
    // them so the next model selection deterministically reloads this version.
    for (const candidate of this.ctx.userDirectory?.list?.() ?? []) {
      hostModelGateway.removeUserProvider(candidate.username, record.providerId);
      const selection = this.selectionForUser(candidate.id);
      if (selection.kind === "public" && selection.profileId === record.providerId) {
        this.refreshUserRuntimes(candidate.id);
      }
    }
    return { provider: publicRecord(record, true) };
  }

  select(connection, params = {}) {
    const user = this.currentUser(connection);
    return this.selectForUser(user, params);
  }

  selectForUser(user, params = {}) {
    const id = requiredText(params.id, "provider id");
    const record = this.recordsForUser(user.id).find((candidate) => candidate.providerId === id);
    if (!record) throw new Error(`unknown model provider ${JSON.stringify(id)}`);
    const apiKey = String(params.apiKey ?? "").trim();
    const current = this.selectionForUser(user.id);
    if (current.kind === "api" && current.profileId === id && !apiKey &&
        hostModelGateway?.credentialLoaded?.(user.username, id) === true) {
      return { provider: publicRecord({ ...record, active: true }, true), runtimeRefresh: { retired: 0, deferred: 0 } };
    }
    this.deactivateAll(user.id);
    record.active = true;
    record.updatedAtMs = Date.now();
    this.save(record);
    if (apiKey) this.apply(user, record, apiKey);
    else hostModelGateway.activateUser(user.username, record.providerId);
    this.setSelection(user.id, "api", record.providerId);
    return {
      provider: publicRecord(record, true),
      runtimeRefresh: this.refreshUserRuntimes(user.id),
    };
  }

  selectPublicForUser(user, params = {}) {
    const id = requiredText(params.id, "provider id");
    const record = this.publicRecords().find((candidate) => candidate.providerId === id);
    if (!record) throw new Error(`unknown public model provider ${JSON.stringify(id)}`);
    const current = this.selectionForUser(user.id);
    if (current.kind === "public" && current.profileId === id &&
        hostModelGateway?.credentialLoaded?.(user.username, id) === true) {
      return { provider: publicRecord({ ...record, active: true }, true), runtimeRefresh: { retired: 0, deferred: 0 } };
    }
    const apiKey = this.publicCredentials.get(id);
    if (hostModelGateway?.credentialLoaded?.(user.username, id) === true) {
      hostModelGateway.activateUser(user.username, id);
    } else if (apiKey) {
      this.apply(user, record, apiKey);
    } else {
      throw new Error(`public model ${record.displayName} has no persisted API key; ask an administrator to save it again`);
    }
    this.deactivateAll(user.id);
    this.setSelection(user.id, "public", id);
    return {
      provider: publicRecord({ ...record, active: true }, true),
      runtimeRefresh: this.refreshUserRuntimes(user.id),
    };
  }

  selectModelForConnection(connection, model) {
    const user = this.currentUser(connection);
    const requested = typeof model === "string"
      ? model.trim()
      : String(model?.id ?? model?.model ?? model?.name ?? "").trim();
    if (!requested) return null;
    const current = this.activeForUser(user.id);
    const codexAvailable = this.codexAvailableForUser(user);
    const selected = this.providerForModel(
      user.id,
      requested,
      current?.providerId ?? null,
      codexAvailable,
    );
    if (!selected) {
      // The requested model is outside the private/public catalog. A bound
      // subscription makes that an explicit Codex route even when the user's
      // default profile currently points at a custom provider. User defaults
      // and per-Turn execution routes are independent dimensions.
      if (codexAvailable) {
        return { kind: "codex", provider: null, runtimeRefresh: { retired: 0, deferred: 0 } };
      }
      // Without a subscription, fail closed rather than accidentally sending
      // an unknown native-looking model id to the active custom provider.
      if (current?.model) {
        throw new Error(`model ${JSON.stringify(requested)} is not available in your private/public catalog`);
      }
      return null;
    }
    console.info(
      `[model-gateway] route user=${user.username} model=${requested} ` +
      `provider=${selected.providerId} visibility=${selected.visibility ?? "private"}`,
    );
    // A model selected for one turn is a Thread execution route, not a new
    // user default. Materialize its credential without mutating the user's
    // execution-profile selection or retiring unrelated Thread runtimes.
    if (selected.visibility === "public") {
      const apiKey = this.publicCredentials.get(selected.providerId);
      if (hostModelGateway?.credentialLoaded?.(user.username, selected.providerId) !== true) {
        if (!apiKey) {
          throw new Error(`public model ${selected.displayName} has no persisted API key; ask an administrator to save it again`);
        }
        this.apply(user, selected, apiKey);
      }
    } else if (hostModelGateway?.credentialLoaded?.(user.username, selected.providerId) !== true) {
      throw new Error(`API key for model provider ${selected.displayName} is not loaded for SSH user ${user.username}`);
    }
    return {
      kind: "dsh",
      engineKind: "dsh",
      provider: publicRecord({ ...selected, active: false }, true),
      runtimeRefresh: { retired: 0, deferred: 0 },
    };
  }

  selectModelForTurn(connection, model, input = []) {
    const route = this.selectModelForConnection(connection, model);
    if (!hasImageInput(input) || route?.kind !== "dsh" || !route.provider) return route;
    const selectedModel = route.provider.model;
    if (selectedModel !== "auto") {
      if (!this.ctx.modelMetadata.supportsRecordInput(route.provider, "image")) {
        throw new Error(
          `model ${JSON.stringify(selectedModel)} does not support image input; ` +
          "select a vision-capable model such as kimi-k2.6",
        );
      }
      return route;
    }

    // TokenHub's `auto` endpoint currently accepts image_url syntactically but
    // silently routes some requests to text-only models. Freeze this Turn to a
    // concrete, catalog-visible vision model on the same endpoint instead.
    const user = this.currentUser(connection);
    const records = this.visibleRecordsForUser(user.id);
    const candidates = records.filter((record) => (
      record.endpoint === route.provider.endpoint &&
      record.model !== "auto" &&
      this.ctx.modelMetadata.supportsRecordInput(record, "image")
    ));
    candidates.sort((left, right) => {
      const leftRank = preferredVisionModels.indexOf(left.model);
      const rightRank = preferredVisionModels.indexOf(right.model);
      const normalizedLeft = leftRank < 0 ? preferredVisionModels.length : leftRank;
      const normalizedRight = rightRank < 0 ? preferredVisionModels.length : rightRank;
      return normalizedLeft - normalizedRight || left.model.localeCompare(right.model);
    });
    const vision = candidates[0];
    if (!vision) {
      throw new Error(
        "the selected auto provider cannot reliably handle images and no vision-capable model " +
        "is configured on the same endpoint",
      );
    }
    console.info(
      `[model-gateway] capability-route user=${user.username} input=image ` +
      `from=${route.provider.providerId ?? route.provider.id} to=${vision.providerId} model=${vision.model}`,
    );
    return this.selectModelForConnection(connection, vision.providerId);
  }

  setDefaultModelForConnection(connection, model) {
    const user = this.currentUser(connection);
    const requested = requiredText(model, "model");
    const current = this.activeForUser(user.id);
    const selected = this.providerForModel(
      user.id,
      requested,
      current?.providerId ?? null,
      this.codexAvailableForUser(user),
    );
    if (!selected) {
      // A model outside the private/public catalog is a native Codex model.
      // Change only the new-thread execution default; durable Thread routes
      // remain attached to their existing backends.
      this.markCodexProfileActive(user, "default");
      return { kind: "codex", profileId: "default", model: requested };
    }

    if (selected.visibility === "public") {
      const apiKey = this.publicCredentials.get(selected.providerId);
      if (hostModelGateway?.credentialLoaded?.(user.username, selected.providerId) === true) {
        hostModelGateway.activateUser(user.username, selected.providerId);
      } else if (apiKey) {
        this.apply(user, selected, apiKey);
      } else {
        throw new Error(`public model ${selected.displayName} has no persisted API key; ask an administrator to save it again`);
      }
      this.deactivateAll(user.id);
      this.setSelection(user.id, "public", selected.providerId);
      return { kind: "public", profileId: selected.providerId, model: selected.model };
    }

    if (hostModelGateway?.credentialLoaded?.(user.username, selected.providerId) !== true) {
      throw new Error(`API key for model provider ${selected.displayName} is not loaded for SSH user ${user.username}`);
    }
    this.deactivateAll(user.id);
    selected.active = true;
    selected.updatedAtMs = Date.now();
    this.save(selected);
    hostModelGateway.activateUser(user.username, selected.providerId);
    this.setSelection(user.id, "api", selected.providerId);
    return { kind: "api", profileId: selected.providerId, model: selected.model };
  }

  codexAvailableForUser(user) {
    const subscriptions = this.codexProfileSource?.list(user) ?? [];
    return subscriptions.length > 0 || this.codexFallbackSource?.available(user) === true;
  }

  observeNativeCodexModels(models) {
    this.nativeCodexModels ??= new Set(["gpt-5.6-sol"]);
    for (const model of Array.isArray(models) ? models : []) {
      const id = String(model?.id ?? model?.model ?? "").trim();
      if (id) this.nativeCodexModels.add(id);
    }
  }

  isNativeCodexModel(model) {
    return model === "gpt-5.6-sol" || this.nativeCodexModels?.has(model) === true;
  }

  providerForModel(userId, requested, preferredProviderId = null, preferNativeModel = false) {
    const matchesRequested = (record) => [record.model, record.providerId, record.displayName]
      .some((candidate) => typeof candidate === "string" && candidate === requested);
    const privateMatches = this.recordsForUser(userId).filter(matchesRequested);
    const publicMatches = this.publicRecords().filter(matchesRequested);
    const matches = privateMatches.length > 0 ? privateMatches : publicMatches;
    if (matches.length === 0) return null;
    if (preferNativeModel && this.isNativeCodexModel(requested) &&
        matches.some((record) => record.model === requested)) {
      // Native subscription models and custom providers share the model-id
      // namespace in Desktop. The merged catalog keeps the native entry when
      // ids collide, so routing must do the same. A custom provider remains
      // explicitly selectable by its provider id or a distinct display name.
      const explicit = matches.filter((record) => (
        record.providerId === requested ||
        (record.displayName === requested && record.model !== requested)
      ));
      if (explicit.length === 0) return null;
      if (explicit.length === 1) return explicit[0];
      const preferredExplicit = explicit.find((record) => record.providerId === preferredProviderId);
      if (!preferredExplicit) {
        throw new Error(`model provider ${JSON.stringify(requested)} is ambiguous`);
      }
      return preferredExplicit;
    }
    const preferred = matches.find((record) => record.providerId === preferredProviderId);
    if (matches.length > 1 && !preferred) {
      throw new Error(`model id ${JSON.stringify(requested)} is ambiguous across multiple providers`);
    }
    return preferred ?? matches[0];
  }

  ensureRuntimeProvider(userId, providerId) {
    if (!providerId) return null;
    const user = this.ctx.userDirectory.find(userId);
    if (!user) throw new Error(`unknown HyperNode user ${JSON.stringify(userId)}`);
    const record = [
      ...this.recordsForUser(userId),
      ...this.publicRecords(),
    ].find((candidate) => candidate.providerId === providerId);
    if (!record) throw new Error(`model provider ${JSON.stringify(providerId)} is not available to ${user.username}`);
    if (hostModelGateway?.credentialLoaded?.(user.username, providerId) === true) return record;
    if (record.visibility !== "public") {
      throw new Error(`API key for model provider ${record.displayName} is not loaded for SSH user ${user.username}`);
    }
    const apiKey = this.publicCredentials.get(providerId);
    if (!apiKey) {
      throw new Error(`public model ${record.displayName} has no persisted API key; ask an administrator to save it again`);
    }
    // Public credentials are platform-owned, but the Go host intentionally
    // keeps one runtime credential projection per Linux user. Opening a
    // Thread created by somebody else must therefore materialize that same
    // public provider for the current executor before Codex is spawned.
    this.apply(user, record, apiKey);
    return record;
  }

  remove(connection, params = {}) {
    const user = this.currentUser(connection);
    const id = requiredText(params.id, "provider id");
    const record = this.recordsForUser(user.id).find((candidate) => candidate.providerId === id);
    if (!record) return { removed: false };
    if (this.ctx.storage.available) {
      this.ctx.storage.sql.exec(
        "DELETE FROM do_model_gateway_profiles WHERE user_id = ? AND provider_id = ?",
        user.id, id,
      );
    } else {
      this.fallback.set(user.id, this.recordsForUser(user.id).filter((candidate) => candidate.providerId !== id));
    }
    hostModelGateway.unregisterProvider(id);
    hostModelGateway.removeUserProvider(user.username, id);
    const wasActive = this.activeForUser(user.id)?.providerId === id ||
      this.selectionForUser(user.id).profileId === id;
    const switched = wasActive ? this.useDefaultForUser(user) : null;
    return { removed: true, runtimeRefresh: switched?.runtimeRefresh ?? null };
  }

  useDefaultForUser(user) {
    const provider = this.defaultPublicRecord();
    if (!provider) return this.useSubscriptionForUser(user);
    return this.selectPublicForUser(user, { id: provider.providerId });
  }

  useSubscription(connection) {
    return this.useSubscriptionForUser(this.currentUser(connection));
  }

  useSubscriptionForUser(user, profileId = "default") {
    this.markCodexProfileActive(user, profileId);
    return {
      profile: { kind: "codex", id: profileId, name: "Codex 订阅" },
      runtimeRefresh: this.refreshUserRuntimes(user.id),
    };
  }

  markCodexProfileActive(user, profileId = "default") {
    this.deactivateAll(user.id);
    this.setSelection(user.id, "codex", profileId);
    hostModelGateway.deactivateUser(user.username);
    return { kind: "codex", id: profileId };
  }

  switchProfile(connection, params = {}) {
    return this.switchProfileForUser(this.currentUser(connection), params);
  }

  switchProfileForUser(user, params = {}) {
    const value = requiredText(params.profile, "execution profile");
    if (value.startsWith("codex:")) {
      const profileId = value.slice("codex:".length);
      if (profileId !== "default") {
        if (!this.codexProfileSource) throw new Error("Codex subscription profiles are unavailable");
        this.codexProfileSource.activate(user, profileId);
      }
      return this.useSubscriptionForUser(user, profileId);
    }
    if (value.startsWith("public:")) {
      return this.selectPublicForUser(user, { id: value.slice("public:".length) });
    }
    if (value.startsWith("api:")) {
      return this.selectForUser(user, {
        id: value.slice("api:".length),
        apiKey: params.apiKey,
      });
    }
    throw new Error(`unsupported execution profile ${JSON.stringify(value)}`);
  }

  deactivateAll(userId) {
    if (this.ctx.storage.available) {
      this.ctx.storage.sql.exec(
        "UPDATE do_model_gateway_profiles SET active = 0, updated_at_ms = ? WHERE user_id = ? AND active != 0",
        Date.now(), userId,
      );
      return;
    }
    for (const record of this.fallback.get(userId) ?? []) record.active = false;
  }

  save(record) {
    if (this.ctx.storage.available) {
      this.ctx.storage.sql.exec(`
        INSERT INTO do_model_gateway_profiles(
          user_id, provider_id, display_name, endpoint, model, active, configured_at_ms, updated_at_ms,
          api_protocol, input_modalities
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, provider_id) DO UPDATE SET
          display_name = excluded.display_name,
          endpoint = excluded.endpoint,
          model = excluded.model,
          active = excluded.active,
          api_protocol = excluded.api_protocol,
          input_modalities = excluded.input_modalities,
          updated_at_ms = excluded.updated_at_ms
      `, record.userId, record.providerId, record.displayName, record.endpoint, record.model,
      record.active ? 1 : 0, record.configuredAtMs, record.updatedAtMs, record.apiProtocol,
      storedInputModalities(record.inputModalities));
      return;
    }
    const records = this.fallback.get(record.userId) ?? [];
    const index = records.findIndex((candidate) => candidate.providerId === record.providerId);
    if (index < 0) records.push(record);
    else records[index] = record;
    this.fallback.set(record.userId, records);
  }

  apply(user, record, apiKey) {
    hostModelGateway.configureUser(
      user.username,
      Number(user.linuxUid ?? 0),
      Number(user.linuxGid ?? user.linuxUid ?? 0),
      user.installationId ?? "",
      record.providerId,
      record.endpoint,
      apiKey,
      record.model ?? "",
      record.displayName,
    );
  }

  refreshUserRuntimes(userId) {
    return this.runtimeRetirer?.(userId) ?? { retired: 0, deferred: 0 };
  }

  attachRuntimeRetirer(retirer) {
    if (this.runtimeRetirer && this.runtimeRetirer !== retirer) {
      throw new Error("model gateway runtime retirer is already attached");
    }
    this.runtimeRetirer = retirer;
    return () => {
      if (this.runtimeRetirer === retirer) this.runtimeRetirer = null;
    };
  }

  attachCodexProfileSource(source) {
    if (!source || typeof source.list !== "function" || typeof source.activate !== "function") {
      throw new Error("invalid Codex profile source");
    }
    if (this.codexProfileSource && this.codexProfileSource !== source) {
      throw new Error("Codex profile source is already attached");
    }
    this.codexProfileSource = source;
    return () => {
      if (this.codexProfileSource === source) this.codexProfileSource = null;
    };
  }

  attachCodexFallbackSource(source) {
    if (!source || typeof source.available !== "function") {
      throw new Error("invalid Codex fallback source");
    }
    if (this.codexFallbackSource && this.codexFallbackSource !== source) {
      throw new Error("Codex fallback source is already attached");
    }
    this.codexFallbackSource = source;
    return () => {
      if (this.codexFallbackSource === source) this.codexFallbackSource = null;
    };
  }

  render(connection) {
    const providers = this.list(connection);
    const selection = this.selectionForUser(this.currentUser(connection).id);
    if (providers.length === 0) {
      return [
        "当前执行身份：Codex 订阅 · 当前绑定账户。",
        "当前没有自定义模型 Provider。",
        "",
        "添加：`$models add <Chat Completions URL> <API Key> [model]`",
        "个人 Provider 的 API Key 只驻内存；管理员配置的公共模型凭据持久化在仅 root 可读的 HyperNode SQLite 中。",
      ].join("\n");
    }
    return [
      `当前执行身份：${selection.kind === "codex" ? "Codex 订阅 · 当前绑定账户" : "自定义 API"}。`,
      "HyperNode 自定义模型 Provider：",
      ...providers.map((provider) =>
        `- ${provider.active ? "●" : "○"} ${provider.name} · ${provider.model ?? "沿用会话模型"} · ` +
        `${provider.endpoint} · 凭据${provider.credentialLoaded ? "已加载" : "需重新提供"}`),
      "",
      "个人 Provider 的 API Key 只驻内存；公共模型凭据持久化在仅 root 可读的 HyperNode SQLite 中。通过管理技能提交个人 Key 时，用户消息本身仍会进入会话历史。",
      "切回订阅：`$models subscription`；切换 API：`$models select <provider id> [API Key]`；删除：`$models remove <provider id>`。",
    ].join("\n");
  }

  executeSkill(input, invocation) {
    const words = skillWords(input);
    const command = words[0]?.toLowerCase();
    if (!command || ["list", "ls", "show"].includes(command)) return this.render(invocation.connection);
    if (["add", "configure", "config"].includes(command)) {
      if (!words[1] || !words[2]) {
        return "用法：`$models add <Chat Completions URL> <API Key> [model]`";
      }
      const result = this.configure(invocation.connection, {
        endpoint: words[1], apiKey: words[2], model: words[3] ?? null,
      });
      return `已启用 ${result.provider.name}（${result.provider.id}）` +
        `，模型 ${result.provider.model ?? "沿用会话选择"}。` +
        (result.runtimeRefresh.deferred > 0
          ? ` 当前有 ${result.runtimeRefresh.deferred} 个运行中的后端，将在 turn 结束后切换。`
          : " 空闲 Codex 后端已刷新，下一个 turn 生效。");
    }
    if (["select", "use", "switch"].includes(command)) {
      if (!words[1]) return "用法：`$models select <provider id> [API Key]`";
      const result = this.select(invocation.connection, { id: words[1], apiKey: words[2] });
      return `已切换到 ${result.provider.name}（${result.provider.id}）。`;
    }
    if (["subscription", "codex", "default"].includes(command)) {
      const result = this.useSubscription(invocation.connection);
      return `已切换到 ${result.profile.name}；下一个 Turn 生效。`;
    }
    if (["remove", "delete", "rm"].includes(command)) {
      if (!words[1]) return "用法：`$models remove <provider id>`";
      return this.remove(invocation.connection, { id: words[1] }).removed
        ? `已删除模型 Provider ${words[1]}。`
        : `没有找到模型 Provider ${words[1]}。`;
    }
    return "未知 models 命令。支持：list、add、select、subscription、remove。";
  }
}

// Runtime retirement is an optional late hook. Declaring transparentCodexThread
// as a startup dependency would create a Cordis cycle through CredentialService:
// modelGateway -> transparentCodexThread -> credential -> modelGateway.
ModelGatewayService.inject = ["appServer", "dashboard", "storage", "userDirectory", "modelMetadata"];
