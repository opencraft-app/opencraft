import { Service, type Inject } from "@deepseek-ai/cordis";
import {
  HYPERNODE_ROUTER_PROVIDER_CONFIG,
  HYPERNODE_ROUTER_PROVIDER_ID,
} from "./model-router.ts";
import type {
  AppServerConnection,
  AppServerParams,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

type Dependencies = "appServer" | "modelGateway" | "storage";

interface UserConfigDefaults {
  model?: string;
  model_reasoning_effort?: string | null;
}

interface ConfigEdit {
  keyPath: string;
  mergeStrategy: string;
  value: unknown;
}

interface ConfigDefaultRow extends Record<string, import("../types/storage.ts").SqlValue> {
  key_path: string;
  value_json: string;
}

const config = {
  model: "gpt-5.6-sol",
  review_model: null,
  model_context_window: null,
  model_auto_compact_token_limit: null,
  model_auto_compact_token_limit_scope: null,
  model_provider: null,
  model_providers: {},
  approval_policy: "on-request",
  approvals_reviewer: "user",
  sandbox_mode: "workspace-write",
  sandbox_workspace_write: null,
  forced_chatgpt_workspace_id: null,
  forced_login_method: null,
  web_search: null,
  tools: null,
  instructions: null,
  developer_instructions: null,
  compact_prompt: null,
  model_reasoning_effort: "xhigh",
  model_reasoning_summary: null,
  model_verbosity: null,
  service_tier: "priority",
  analytics: null,
  desktop: null,
  projects: {
    "/workspace": { trust_level: "trusted" },
  },
  features: {
    auth_elicitation: true,
    apps_mcp_path_override: true,
    remote_plugin: true,
    tool_suggest: true,
  },
};

const writableDefaultKeys = new Set<keyof UserConfigDefaults>([
  "model",
  "model_reasoning_effort",
]);

function effectiveDefaultKey(keyPath: unknown): keyof UserConfigDefaults | null {
  const match = String(keyPath ?? "").match(
    /^(?:profiles\.[^.]+\.)?(model|model_reasoning_effort)$/,
  );
  const key = match?.[1];
  return key === "model" || key === "model_reasoning_effort" ? key : null;
}

function configEdits(params: AppServerParams): ConfigEdit[] {
  const edits = params["edits"];
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("config/batchWrite requires at least one edit");
  }
  return edits.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("config/batchWrite edit must be an object");
    }
    const edit = candidate as Record<string, unknown>;
    return {
      keyPath: String(edit["keyPath"] ?? ""),
      mergeStrategy: String(edit["mergeStrategy"] ?? ""),
      value: edit["value"],
    };
  });
}

export class ConfigService extends Service {
  static inject = [
    "appServer",
    "modelGateway",
    "storage",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly fallbackDefaults = new Map<string, UserConfigDefaults>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "config");
    this.ensureSchema();
    ctx.effect(() => ctx.appServer.register(
      "configRequirements/read",
      () => ({ requirements: null }),
    ));
    ctx.effect(() => ctx.appServer.register("config/read", (params, connection) => ({
      config: this.forConnection(connection),
      origins: {},
      layers: params["includeLayers"] ? [] : null,
    })));
    ctx.effect(() => ctx.appServer.register(
      "config/batchWrite",
      (params, connection) => this.batchWrite(params, connection),
    ));
  }

  ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) return;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS do_user_config_defaults (
        user_id TEXT NOT NULL,
        key_path TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(user_id, key_path)
      )
    `);
  }

  defaultsForUser(userId: string): UserConfigDefaults {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) {
      return { ...(this.fallbackDefaults.get(userId) ?? {}) };
    }
    const values: UserConfigDefaults = {};
    const rows = sql.exec<ConfigDefaultRow>(`
      SELECT key_path, value_json
      FROM do_user_config_defaults
      WHERE user_id = ?
    `, userId).toArray();
    for (const row of rows) {
      const key = effectiveDefaultKey(row.key_path);
      if (key === null || !writableDefaultKeys.has(key)) continue;
      try {
        const value: unknown = JSON.parse(row.value_json);
        if (key === "model" && typeof value === "string") values.model = value;
        if (key === "model_reasoning_effort" &&
            (typeof value === "string" || value === null)) {
          values.model_reasoning_effort = value;
        }
      } catch {
        // Ignore malformed legacy rows; a subsequent write repairs them.
      }
    }
    return values;
  }

  saveDefaults(userId: string, values: UserConfigDefaults): void {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) {
      this.fallbackDefaults.set(userId, { ...values });
      return;
    }
    const now = Date.now();
    for (const [keyPath, value] of Object.entries(values)) {
      sql.exec(`
        INSERT INTO do_user_config_defaults(user_id, key_path, value_json, updated_at_ms)
        VALUES(?,?,?,?)
        ON CONFLICT(user_id, key_path) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at_ms = excluded.updated_at_ms
      `, userId, keyPath, JSON.stringify(value), now);
    }
  }

  batchWrite(params: AppServerParams, connection: AppServerConnection): {
    status: "ok";
    version: string;
    filePath: string;
    overriddenMetadata: null;
  } {
    const edits = configEdits(params);
    const user = this.ctx.modelGateway.currentUser(connection);
    const previous = this.defaultsForUser(user.id);
    const next = { ...previous };
    let modelChanged = false;
    for (const edit of edits) {
      const key = effectiveDefaultKey(edit.keyPath);
      if (key === null || !writableDefaultKeys.has(key)) {
        throw new Error(`unsupported HyperNode config key ${JSON.stringify(edit.keyPath)}`);
      }
      if (edit.mergeStrategy !== "upsert" && edit.mergeStrategy !== "replace") {
        throw new Error(`unsupported merge strategy ${JSON.stringify(edit.mergeStrategy)}`);
      }
      if (key === "model") {
        const model = String(edit.value ?? "").trim();
        if (!model) throw new Error("model must be a non-empty string");
        next.model = model;
        modelChanged = true;
      } else {
        next.model_reasoning_effort = edit.value == null ? null : String(edit.value);
      }
    }
    if (modelChanged && next.model !== undefined) {
      this.ctx.modelGateway.setDefaultModelForConnection(connection, next.model);
    }
    this.saveDefaults(user.id, next);
    return {
      status: "ok",
      version: `hypernode-${Date.now()}`,
      filePath: "/workspace/.codex/config.toml",
      overriddenMetadata: null,
    };
  }

  forConnection(connection: AppServerConnection): Record<string, unknown> {
    const provider = this.ctx.modelGateway.activeForConnection(connection);
    const userId = connection.identity?.id;
    const defaults = userId ? this.defaultsForUser(userId) : {};
    let model = defaults.model ?? config.model;
    if (provider?.model) {
      model = provider.model;
    } else if (userId && defaults.model &&
        this.ctx.modelGateway.providerForModel(userId, defaults.model)) {
      // A stale routed model default must not resurrect an old API execution profile.
      model = config.model;
    }
    return {
      ...config,
      ...defaults,
      model,
      model_provider: HYPERNODE_ROUTER_PROVIDER_ID,
      model_providers: {
        [HYPERNODE_ROUTER_PROVIDER_ID]: HYPERNODE_ROUTER_PROVIDER_CONFIG,
      },
    };
  }
}
