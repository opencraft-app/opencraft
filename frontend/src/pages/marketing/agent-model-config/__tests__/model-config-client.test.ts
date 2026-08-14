import { spawnSync } from "node:child_process";
import { constants, generateKeyPairSync, publicEncrypt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HERMES_MODEL_CONFIG_JSON_END,
  HERMES_MODEL_CONFIG_JSON_START,
  buildHermesModelConfigCommand,
} from "../hermes-model-config-command";
import {
  createHermesModelConfigClient,
  parseHermesConnectionProbeResponse,
  parseHermesCredentialEnvelopePreparation,
  parseHermesModelConfigResponse,
  type HermesModelConfigAction,
  type ModelProviderOption,
} from "../model-config-client";

const apiKey = "lv-test-secret-key";
const model = {
  id: "deepseek-v3",
  providerKey: "deepseek",
  providerName: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiMode: "chat_completions",
  keyEnv: "",
};
const configuredModel = { ...model, providerKey: "lightvela-deepseek", keyEnv: "KEY_lightvela_deepseek" };
const snapshot = { primary: configuredModel, fallbacks: [], configuredModels: [configuredModel] };
const { publicKey: testPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const envelopePreparation = { token: "a".repeat(48), publicKey: testPublicKey };

type PlaintextTestAction =
  | Exclude<HermesModelConfigAction, Extract<HermesModelConfigAction, { type: "probe" | "connectivityProbe" | "add" }>>
  | { type: "probe"; apiKey: string; baseUrl: string; apiMode?: string }
  | { type: "connectivityProbe"; apiKey: string; model: typeof model }
  | { type: "add"; apiKey: string; model: typeof model; purpose: "primary" | "fallback" | "idle" };

function response(payload: unknown): string {
  return ["transport diagnostic", HERMES_MODEL_CONFIG_JSON_START, JSON.stringify(payload), HERMES_MODEL_CONFIG_JSON_END].join("\n");
}

function action(type: PlaintextTestAction["type"]): PlaintextTestAction {
  switch (type) {
    case "prepareCredentialEnvelope": return { type };
    case "read": return { type };
    case "probe": return { type, apiKey, baseUrl: model.baseUrl, apiMode: model.apiMode };
    case "connectivityProbe": return { type, apiKey, model };
    case "add": return { type, apiKey, model, purpose: "primary" };
    case "assign": return { type, providerKey: configuredModel.providerKey, modelId: model.id, purpose: "fallback" };
    case "removeFallback": return { type, providerKey: configuredModel.providerKey, modelId: model.id };
    case "remove": return { type, providerKey: configuredModel.providerKey, modelId: model.id };
  }
}

function encryptCredential(publicKey: string, credential: string) {
  const bytes = Buffer.from(credential, "utf8");
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 190) {
    chunks.push(publicEncrypt({
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, bytes.subarray(offset, offset + 190)).toString("base64"));
  }
  return chunks.join(".");
}

function writeHermesStubs(directory: string, legacyHermes = false, providerSchema = true): void {
  const packageDir = join(directory, "hermes_cli");
  writeFileSync(join(directory, "hermes_cli", "__init__.py"), "", { encoding: "utf8" });
  writeFileSync(join(packageDir, "config.py"), String.raw`
import copy, json, os, re
from pathlib import Path
ROOT = Path(os.environ["HERMES_HOME"])
def event(name):
    path = ROOT / "events.json"
    values = json.loads(path.read_text()) if path.exists() else []
    values.append(name)
    path.write_text(json.dumps(values))
def load_config():
    path = ROOT / "config.json"
    return json.loads(path.read_text()) if path.exists() else {}
def load_env():
    path = ROOT / "credentials.json"
    return json.loads(path.read_text()) if path.exists() else {}
def save_config(value):
    event("save_config")
    if os.environ.get("FAIL_CONFIG_SAVE"):
        raise RuntimeError("config save failure")
    count_path = ROOT / "save-count"
    save_count = int(count_path.read_text()) + 1 if count_path.exists() else 1
    count_path.write_text(str(save_count))
    if os.environ.get("CORRUPT_SAVED_ROLE") and save_count == 1:
        value = copy.deepcopy(value)
        value["model"] = {"provider": "corrupt", "default": "corrupt"}
    (ROOT / "config.json").write_text(json.dumps(value))
def save_env_value(key, value):
    event("save_env_value")
    credentials = load_env()
    credentials[key] = value
    (ROOT / "credentials.json").write_text(json.dumps(credentials))
def remove_env_value(key):
    event("remove_env_value")
    credentials = load_env()
    credentials.pop(key, None)
    (ROOT / "credentials.json").write_text(json.dumps(credentials))
${legacyHermes ? "" : String.raw`
def custom_endpoint_key_env(identity):
    return "KEY_" + re.sub(r"[^A-Za-z0-9]+", "_", identity).strip("_")
`}
${providerSchema ? String.raw`
def providers_dict_to_custom_providers(value):
    return []
` : ""}
`, { encoding: "utf8" });
  if (!legacyHermes) writeFileSync(join(packageDir, "credential_lifecycle.py"), String.raw`
import json, os
from pathlib import Path
ROOT = Path(os.environ["HERMES_HOME"])
def event(name):
    path = ROOT / "events.json"
    values = json.loads(path.read_text()) if path.exists() else []
    values.append(name)
    path.write_text(json.dumps(values))
def save_provider_env_credential(key, value):
    event("save_credential")
    if os.environ.get("FAIL_SAVE_CREDENTIAL"):
        raise RuntimeError("credential failure: " + value)
    credentials = json.loads((ROOT / "credentials.json").read_text()) if (ROOT / "credentials.json").exists() else {}
    credentials[key] = value
    (ROOT / "credentials.json").write_text(json.dumps(credentials))
    config_path = ROOT / "config.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    config["lifecycle_marker"] = "after-save"
    config_path.write_text(json.dumps(config))
    return {"ok": True}
def remove_provider_env_credential(key):
    event("remove_credential")
    if os.environ.get("FAIL_REMOVE_CREDENTIAL"):
        raise RuntimeError("credential removal failure")
    credentials = json.loads((ROOT / "credentials.json").read_text()) if (ROOT / "credentials.json").exists() else {}
    credentials.pop(key, None)
    (ROOT / "credentials.json").write_text(json.dumps(credentials))
    return {"ok": True}
`, { encoding: "utf8" });
  if (!legacyHermes) writeFileSync(join(packageDir, "fallback_config.py"), String.raw`
def get_fallback_chain(config):
    values = config.get("fallback_providers") or []
    if isinstance(values, dict): values = [values]
    legacy = config.get("fallback_model")
    if legacy: values = values + ([legacy] if isinstance(legacy, dict) else legacy)
    return values
`, { encoding: "utf8" });
  writeFileSync(join(packageDir, "models.py"), legacyHermes ? String.raw`
import json, os
from pathlib import Path
def fetch_api_models(api_key, base_url, timeout=5):
    root = Path(os.environ["HERMES_HOME"])
    events = root / "events.json"
    values = json.loads(events.read_text()) if events.exists() else []
    values.append("fetch_api_models")
    events.write_text(json.dumps(values))
    return ["legacy-alpha", "legacy-alpha", "legacy-beta"]
` : String.raw`
import json, os
from pathlib import Path
def probe_api_models(api_key, base_url, timeout=5, api_mode=None):
    root = Path(os.environ["HERMES_HOME"])
    events = root / "events.json"
    values = json.loads(events.read_text()) if events.exists() else []
    values.append("probe")
    events.write_text(json.dumps(values))
    return {"models": ["alpha", "alpha", "beta"]}
`, { encoding: "utf8" });

  const acliPath = join(directory, "acli");
  writeFileSync(acliPath, String.raw`#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if args[:2] != ["model", "probe"]:
    print(json.dumps({"success": False, "error": {"code": "UNSUPPORTED", "message": "unsupported command"}}))
    raise SystemExit(1)

def value(name):
    return args[args.index(name) + 1]

print(json.dumps({
    "success": True,
    "data": {
        "success": True,
        "error_code": 0,
        "provider": value("--provider"),
        "model": value("--model"),
        "base_url": value("--base-url"),
        "time_ms": 128,
        "results": [{"success": True, "model": value("--model"), "time_ms": 128}],
    },
    "error": None,
}))
`, { encoding: "utf8" });
  chmodSync(acliPath, 0o755);
}

function runHelper(
  inputAction: PlaintextTestAction,
  config: Record<string, unknown>,
  env: Record<string, string> = {},
  credentials: Record<string, string> = {},
  legacyHermes = false,
  providerSchema = true,
  envelopeMutation?: "expire" | "corrupt",
) {
  const directory = mkdtempSync(join(tmpdir(), "lightvela-hermes-model-config-"));
  try {
    const packageDir = join(directory, "hermes_cli");
    writeFileSync(join(directory, "config.json"), JSON.stringify(config), "utf8");
    writeFileSync(join(directory, "events.json"), "[]", "utf8");
    writeFileSync(join(directory, "credentials.json"), JSON.stringify(credentials), "utf8");
    mkdirSync(packageDir);
    writeHermesStubs(directory, legacyHermes, providerSchema);
    const spawnAction = (remoteAction: HermesModelConfigAction) => spawnSync(buildHermesModelConfigCommand(remoteAction), {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, ...env, HERMES_HOME: directory, PYTHONPATH: directory, PATH: `${directory}:${process.env.PATH ?? ""}` },
      shell: true,
    });
    let remoteAction: HermesModelConfigAction = inputAction as HermesModelConfigAction;
    let preparationOutput = "";
    if (inputAction.type === "probe" || inputAction.type === "connectivityProbe" || inputAction.type === "add") {
      const preparationResult = spawnAction({ type: "prepareCredentialEnvelope" });
      preparationOutput = `${preparationResult.stdout}${preparationResult.stderr}`;
      const preparation = parseHermesCredentialEnvelopePreparation(preparationOutput);
      const credentialEnvelope = {
        token: preparation.token,
        ciphertext: envelopeMutation === "corrupt" ? "invalid-ciphertext" : encryptCredential(preparation.publicKey, inputAction.apiKey),
      };
      if (envelopeMutation === "expire") {
        const expired = new Date(Date.now() - 11 * 60 * 1000);
        utimesSync(join(directory, ".lightvela-credential-envelopes", `${preparation.token}.pem`), expired, expired);
      }
      remoteAction = inputAction.type === "probe"
        ? { type: "probe", credentialEnvelope, baseUrl: inputAction.baseUrl, apiMode: inputAction.apiMode }
        : inputAction.type === "connectivityProbe"
          ? { type: "connectivityProbe", credentialEnvelope, model: inputAction.model }
          : { type: "add", credentialEnvelope, model: inputAction.model, purpose: inputAction.purpose };
    }
    const command = buildHermesModelConfigCommand(remoteAction);
    const result = spawnSync(command, {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, ...env, HERMES_HOME: directory, PYTHONPATH: directory, PATH: `${directory}:${process.env.PATH ?? ""}` },
      shell: true,
    });
    const output = `${result.stdout}${result.stderr}`;
    const envelopeDirectory = join(directory, ".lightvela-credential-envelopes");
    return {
      config: JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as Record<string, unknown>,
      credentials: existsSync(join(directory, "credentials.json"))
        ? JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8")) as Record<string, string>
        : {},
      events: JSON.parse(readFileSync(join(directory, "events.json"), "utf8")) as string[],
      output,
      command,
      preparationOutput,
      remainingEnvelopeFiles: existsSync(envelopeDirectory) ? readdirSync(envelopeDirectory) : [],
      status: result.status,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("Hermes model configuration client", () => {
  const catalogProvider: ModelProviderOption = {
    providerKey: "lightvela-deepseek",
    providerName: "DeepSeek",
    category: "coding_plan",
    baseUrl: model.baseUrl,
    apiMode: "chat_completions",
    description: "DeepSeek coding model",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    catalogModels: [{ id: model.id, name: "DeepSeek V3" }],
  };

  it("encodes action payloads and selects the Hermes runtime without exposing API keys", () => {
    const command = buildHermesModelConfigCommand({
      type: "add",
      credentialEnvelope: { token: "b".repeat(48), ciphertext: "encrypted-value" },
      model,
      purpose: "primary",
    });
    expect(command).toContain('HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"');
    expect(command).toContain('HERMES_PYTHON="$HERMES_ROOT/hermes-agent/venv/bin/python"');
    expect(command).toContain("base64");
    expect(command).not.toContain(apiKey);
    expect(catalogProvider.catalogModels).toEqual([{ id: model.id, name: "DeepSeek V3" }]);
  });

  it("transports long credentials as one-time ciphertext and consumes the private envelope", () => {
    const longCredential = `lv-${"sensitive-value-".repeat(40)}结尾`;
    const added = runHelper({ type: "add", apiKey: longCredential, model, purpose: "idle" }, {});
    const encodedAction = added.command.match(/\$HERMES_PYTHON" - "([A-Za-z0-9+/=]+)"/)?.[1];
    expect(encodedAction).toBeDefined();
    const transported = JSON.parse(Buffer.from(encodedAction!, "base64").toString("utf8")) as Record<string, unknown>;

    expect(transported).not.toHaveProperty("apiKey");
    expect(JSON.stringify(transported)).not.toContain(longCredential);
    expect(added.command).not.toContain(longCredential);
    expect(added.preparationOutput).not.toContain(longCredential);
    expect(added.credentials.KEY_lightvela_deepseek).toBe(longCredential);
    expect(added.remainingEnvelopeFiles).toEqual([]);
  });

  it("rejects expired or malformed credential envelopes and still consumes their private keys", () => {
    for (const mutation of ["expire", "corrupt"] as const) {
      const rejected = runHelper({ type: "add", apiKey, model, purpose: "idle" }, {}, {}, {}, false, true, mutation);
      expect(() => parseHermesModelConfigResponse(rejected.output)).toThrow("Model configuration operation failed");
      expect(rejected.credentials).toEqual({});
      expect(rejected.remainingEnvelopeFiles).toEqual([]);
    }
  });

  it("parses valid marker-wrapped snapshots and rejects invalid payloads", () => {
    expect(parseHermesModelConfigResponse(response({ ok: true, snapshot }))).toEqual(snapshot);
    expect(() => parseHermesModelConfigResponse("not structured")).toThrow("markers");
    expect(() => parseHermesModelConfigResponse(response({ ok: false, error: "generic helper failure" }))).toThrow("generic helper failure");
    expect(() => parseHermesModelConfigResponse(`${HERMES_MODEL_CONFIG_JSON_START}\n{bad}\n${HERMES_MODEL_CONFIG_JSON_END}`)).toThrow("invalid JSON");
    expect(() => parseHermesModelConfigResponse(response({ ok: true, snapshot: { ...snapshot, primary: { ...configuredModel, id: "" } } }))).toThrow("primary.id");
    expect(() => parseHermesModelConfigResponse(response({ ok: true, snapshot: { ...snapshot, fallbacks: {} } }))).toThrow("fallbacks");
    expect(() => parseHermesModelConfigResponse(response({ ok: true, snapshot: { ...snapshot, configuredModels: {} } }))).toThrow("configuredModels");
    expect(() => parseHermesCredentialEnvelopePreparation(response({ ok: true, credentialEnvelope: { token: "", publicKey: "bad" } }))).toThrow("token");
  });

  it("runs the Hermes connectivity probe with an encrypted credential and parses its result", () => {
    const probed = runHelper({ type: "connectivityProbe", apiKey, model }, {});
    expect(parseHermesConnectionProbeResponse(probed.output)).toEqual({
      success: true,
      provider: model.providerKey,
      model: model.id,
      baseUrl: model.baseUrl,
      timeMs: 128,
    });
    expect(probed.command).not.toContain(apiKey);
    expect(probed.output).not.toContain(apiKey);
    expect(probed.remainingEnvelopeFiles).toEqual([]);
  });

  it("rejects malformed connectivity probe responses", () => {
    expect(() => parseHermesConnectionProbeResponse(response({ ok: true, connection: { success: true } }))).toThrow("connection.provider");
    expect(() => parseHermesConnectionProbeResponse(response({
      ok: true,
      connection: { success: false, provider: "deepseek", model: "deepseek-v3", baseUrl: model.baseUrl, timeMs: -1 },
    }))).toThrow("connection.timeMs");
  });

  it("passes every action with bounded timeouts and redacts command failures", async () => {
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      const encoded = command.match(/\$HERMES_PYTHON" - "([A-Za-z0-9+/=]+)"/)?.[1];
      const remoteAction = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as HermesModelConfigAction : null;
      if (remoteAction?.type === "prepareCredentialEnvelope") {
        return { status: "Succeeded", exitCode: 0, output: response({ ok: true, credentialEnvelope: envelopePreparation }) };
      }
      if (remoteAction?.type === "connectivityProbe") {
        return { status: "Succeeded", exitCode: 0, output: response({
          ok: true,
          connection: { success: true, provider: model.providerKey, model: model.id, baseUrl: model.baseUrl, timeMs: 128 },
        }) };
      }
      return { status: "Succeeded", exitCode: 0, output: response({ ok: true, snapshot }) };
    });
    const client = createHermesModelConfigClient(execDebugCommand, "bot-1");
    await client.read();
    await client.probe({ apiKey, baseUrl: model.baseUrl, apiMode: model.apiMode });
    await client.testConnection({ apiKey, model });
    await client.add({ apiKey, model, purpose: "primary" });
    await client.assign({ providerKey: configuredModel.providerKey, modelId: model.id, purpose: "fallback" });
    await client.removeFallback({ providerKey: configuredModel.providerKey, modelId: model.id });
    await client.remove({ providerKey: configuredModel.providerKey, modelId: model.id });
    expect(execDebugCommand.mock.calls.map(([, , options]) => options)).toEqual([
      { timeoutMs: 60_000 }, { timeoutMs: 60_000 }, { timeoutMs: 120_000 },
      { timeoutMs: 60_000 }, { timeoutMs: 120_000 },
      { timeoutMs: 60_000 }, { timeoutMs: 120_000 },
      { timeoutMs: 60_000 }, { timeoutMs: 60_000 }, { timeoutMs: 60_000 },
    ]);
    expect(execDebugCommand.mock.calls.map(([, command]) => command).join("\n")).not.toContain(apiKey);

    execDebugCommand
      .mockResolvedValueOnce({ status: "Succeeded", exitCode: 0, output: response({ ok: true, credentialEnvelope: envelopePreparation }) })
      .mockResolvedValueOnce({ status: "Failed", exitCode: 1, output: `sensitive remote diagnostics with ${apiKey}` });
    const error = await client.add({ apiKey, model, purpose: "idle" }).catch((reason: unknown) => String(reason));
    expect(error).not.toContain(apiKey);
    expect(error).not.toContain("sensitive remote diagnostics");
    expect(error).toContain("Model configuration command failed");
  });

  it("preserves existing route provider IDs and uses providerKey to disambiguate duplicate model IDs", () => {
    const config = {
      model: { provider: "openai", default: "shared", base_url: "https://api.openai.com/v1", api_mode: "chat_completions" },
      providers: { openai: { name: "OpenAI", api: "https://api.openai.com/v1", key_env: "OPENAI_API_KEY", transport: "openai_chat", models: ["shared"] } },
      lightvela: { model_config: { configured_models: [
        { ...configuredModel, id: "shared", providerKey: "lightvela-one" },
        { ...configuredModel, id: "shared", providerKey: "lightvela-two" },
      ] } },
    };
    const read = runHelper({ type: "read" }, config);
    expect(parseHermesModelConfigResponse(read.output).primary?.providerKey).toBe("openai");

    const assigned = runHelper({ type: "assign", providerKey: "lightvela-two", modelId: "shared", purpose: "primary" }, config);
    expect((assigned.config.model as Record<string, unknown>).provider).toBe("lightvela-two");
  });

  it("normalizes canonical provider fields, appends ordered fallbacks, migrates legacy config, and does not write during probe", () => {
    const added = runHelper({ type: "add", apiKey, model: { ...model, apiMode: "openai" }, purpose: "fallback" }, {
      model: { provider: "other", default: "other-model" },
      fallback_providers: [{ provider: "old", model: "old-model" }],
      fallback_model: { provider: "legacy", model: "legacy-model" },
    });
    const provider = (added.config.providers as Record<string, Record<string, unknown>>)["lightvela-deepseek"];
    expect(provider).toEqual(expect.objectContaining({
      name: "DeepSeek", api: model.baseUrl, key_env: "KEY_lightvela_deepseek", transport: "openai_chat", models: [model.id],
    }));
    expect((added.config.model as Record<string, unknown>).api_mode).not.toBe("openai");
    expect(added.config.fallback_providers).toEqual([
      expect.objectContaining({ provider: "old", model: "old-model" }),
      expect.objectContaining({ provider: "legacy", model: "legacy-model" }),
      expect.objectContaining({ provider: "lightvela-deepseek", model: model.id }),
    ]);
    expect(added.config).not.toHaveProperty("fallback_model");

    const deduplicated = runHelper({ type: "add", apiKey, model, purpose: "fallback" }, added.config);
    expect(deduplicated.config.fallback_providers).toHaveLength(3);

    const probe = runHelper({ type: "probe", apiKey, baseUrl: model.baseUrl, apiMode: "chat_completions" }, { marker: "unchanged" });
    expect(parseHermesModelConfigResponse(probe.output).probedModels).toEqual(["alpha", "beta"]);
    expect(probe.config).toEqual({ marker: "unchanged" });
    expect(probe.events).toEqual(["probe"]);
  });

  it("supports older helper APIs on Hermes runtimes that implement the provider schema", () => {
    const added = runHelper({ type: "add", apiKey, model, purpose: "idle" }, {}, {}, {}, true);
    const provider = (added.config.providers as Record<string, Record<string, unknown>>)["lightvela-deepseek"];
    expect(provider.key_env).toBe("HERMES_CUSTOM_LIGHTVELA_DEEPSEEK_API_KEY");
    expect(provider).not.toHaveProperty("api_key");
    expect(added.credentials).toEqual({ HERMES_CUSTOM_LIGHTVELA_DEEPSEEK_API_KEY: apiKey });
    expect(added.events).toEqual(["save_env_value", "save_config"]);

    const probe = runHelper({ type: "probe", apiKey, baseUrl: model.baseUrl, apiMode: model.apiMode }, {}, {}, {}, true);
    expect(parseHermesModelConfigResponse(probe.output).probedModels).toEqual(["legacy-alpha", "legacy-beta"]);
    expect(probe.events).toEqual(["fetch_api_models"]);

    const read = runHelper({ type: "read" }, {
      model: { provider: "legacy-provider", default: "main" },
      fallback_model: "backup",
      providers: { "legacy-provider": { name: "Legacy", api: "https://legacy.example/v1", models: ["main", "backup"] } },
    }, {}, {}, true);
    expect(parseHermesModelConfigResponse(read.output).fallbacks).toEqual([
      expect.objectContaining({ providerKey: "legacy-provider", id: "backup" }),
    ]);
  });

  it("fails closed before credentials are saved on pre-provider-schema Hermes runtimes", () => {
    const blocked = runHelper({ type: "add", apiKey, model, purpose: "idle" }, {}, {}, {}, true, false);
    expect(() => parseHermesModelConfigResponse(blocked.output)).toThrow("Model configuration operation failed");
    expect(blocked.events).toEqual([]);
    expect(blocked.credentials).toEqual({});
    expect(blocked.config).toEqual({});
  });

  it("rejects role conflicts before saving credentials and saves config before removing an unused credential", () => {
    const primary = { ...configuredModel, apiMode: "chat_completions" };
    const conflict = runHelper({ type: "add", apiKey, model: primary, purpose: "fallback" }, {
      model: { provider: primary.providerKey, default: primary.id, base_url: primary.baseUrl, api_mode: primary.apiMode },
    });
    expect(() => parseHermesModelConfigResponse(conflict.output)).toThrow("Model configuration operation failed");
    expect(conflict.events).not.toContain("save_credential");

    const removed = runHelper({ type: "remove", providerKey: primary.providerKey, modelId: primary.id }, {
      lightvela: { model_config: { configured_models: [primary] } },
      providers: { [primary.providerKey]: { name: "DeepSeek", models: [primary.id] } },
    }, { FAIL_REMOVE_CREDENTIAL: "1" });
    expect(() => parseHermesModelConfigResponse(removed.output)).toThrow("Model configuration operation failed");
    expect(removed.events).toEqual(["save_config", "remove_credential", "save_config"]);
    expect((removed.config.providers as Record<string, unknown>)[primary.providerKey]).toBeDefined();
  });

  it("preserves provider extensions and metadata model maps while replacing canonical fields", () => {
    const existingProvider = {
      display_name: "stale name",
      base_url: "https://stale.example",
      url: "https://stale-url.example",
      api_mode: "openai",
      api_key: "stale-inline-secret",
      api_key_env: "STALE_KEY_ENV",
      extra_headers: { "X-Trace": "keep" },
      ssl_verify: false,
      request_overrides: { timeout: 5 },
      models: { retained: { contextWindow: 128_000 } },
    };
    const added = runHelper({ type: "add", apiKey, model, purpose: "idle" }, {
      providers: { "lightvela-deepseek": existingProvider },
    });
    const provider = (added.config.providers as Record<string, Record<string, unknown>>)["lightvela-deepseek"];
    expect(provider).toMatchObject({
      name: model.providerName,
      api: model.baseUrl,
      key_env: "KEY_lightvela_deepseek",
      transport: "openai_chat",
      extra_headers: existingProvider.extra_headers,
      ssl_verify: false,
      request_overrides: existingProvider.request_overrides,
      models: { retained: existingProvider.models.retained, [model.id]: {} },
    });
    expect(provider).not.toHaveProperty("display_name");
    expect(provider).not.toHaveProperty("base_url");
    expect(provider).not.toHaveProperty("url");
    expect(provider).not.toHaveProperty("api_mode");
    expect(provider).not.toHaveProperty("api_key");
    expect(provider).not.toHaveProperty("api_key_env");

    const removed = runHelper({ type: "remove", providerKey: "lightvela-deepseek", modelId: model.id }, {
      lightvela: { model_config: { configured_models: [{ ...configuredModel }] } },
      providers: { "lightvela-deepseek": { ...provider, models: { retained: existingProvider.models.retained, [model.id]: { reasoning: true } } } },
    });
    expect(((removed.config.providers as Record<string, Record<string, unknown>>)["lightvela-deepseek"]).models).toEqual({ retained: existingProvider.models.retained });
  });

  it("reloads lifecycle changes, rolls credentials back after config failure, and applies idle role semantics", () => {
    const added = runHelper({ type: "add", apiKey, model, purpose: "primary" }, { model: { api_key: "inline", api: "legacy" } });
    expect(added.config.lifecycle_marker).toBe("after-save");
    expect(added.config.model).not.toMatchObject({ api_key: expect.anything(), api: expect.anything() });

    const rollback = runHelper({ type: "add", apiKey, model, purpose: "idle" }, {}, { FAIL_CONFIG_SAVE: "1" });
    expect(() => parseHermesModelConfigResponse(rollback.output)).toThrow("Model configuration operation failed");
    expect(rollback.events).toEqual(["save_credential", "save_config", "save_config", "remove_credential"]);
    expect(rollback.credentials).toEqual({});

    const restored = runHelper(
      { type: "add", apiKey, model, purpose: "idle" },
      {},
      { FAIL_CONFIG_SAVE: "1" },
      { KEY_lightvela_deepseek: "previous-credential" },
    );
    expect(restored.events).toEqual(["save_credential", "save_config", "save_config", "save_credential"]);
    expect(restored.credentials).toEqual({ KEY_lightvela_deepseek: "previous-credential" });

    const verificationRollback = runHelper(
      { type: "add", apiKey, model, purpose: "primary" },
      { marker: "original" },
      { CORRUPT_SAVED_ROLE: "1" },
    );
    expect(() => parseHermesModelConfigResponse(verificationRollback.output)).toThrow("Model configuration operation failed");
    expect(verificationRollback.config).toEqual({ marker: "original" });
    expect(verificationRollback.credentials).toEqual({});
    expect(verificationRollback.events).toEqual(["save_credential", "save_config", "save_config", "remove_credential"]);

    const active = { ...configuredModel, id: "active" };
    const idlePrimary = runHelper({ type: "assign", providerKey: active.providerKey, modelId: active.id, purpose: "idle" }, {
      model: { provider: active.providerKey, default: active.id, base_url: active.baseUrl, api_mode: active.apiMode },
      lightvela: { model_config: { configured_models: [active] } },
    });
    expect(() => parseHermesModelConfigResponse(idlePrimary.output)).toThrow("Model configuration operation failed");

    const idleFallback = runHelper({ type: "assign", providerKey: active.providerKey, modelId: active.id, purpose: "idle" }, {
      fallback_providers: [{ provider: active.providerKey, model: active.id, base_url: active.baseUrl, api_mode: active.apiMode }],
      lightvela: { model_config: { configured_models: [active] } },
    });
    expect(parseHermesModelConfigResponse(idleFallback.output).fallbacks).toEqual([]);
  });

  it("persists imported route models when they are first assigned or detached", () => {
    const imported = {
      id: "imported-backup",
      providerKey: "existing-provider",
      providerName: "Existing Provider",
      baseUrl: "https://existing.example.com/v1",
      apiMode: "chat_completions",
      keyEnv: "EXISTING_API_KEY",
    };
    const config = {
      providers: {
        [imported.providerKey]: {
          name: imported.providerName,
          api: imported.baseUrl,
          key_env: imported.keyEnv,
          transport: "openai_chat",
          models: [imported.id],
        },
      },
      fallback_providers: [{
        provider: imported.providerKey,
        model: imported.id,
        base_url: imported.baseUrl,
        api_mode: imported.apiMode,
      }, {
        provider: "second-provider",
        model: "second-backup",
        base_url: "https://second.example.com/v1",
        api_mode: "chat_completions",
      }],
    };

    const assigned = runHelper({
      type: "assign",
      providerKey: imported.providerKey,
      modelId: imported.id,
      purpose: "primary",
    }, config);
    const assignedSnapshot = parseHermesModelConfigResponse(assigned.output);
    expect(assignedSnapshot.primary).toMatchObject(imported);
    expect(assignedSnapshot.fallbacks).toEqual([
      expect.objectContaining({ providerKey: "second-provider", id: "second-backup" }),
    ]);
    expect((((assigned.config.lightvela as Record<string, unknown>).model_config as Record<string, unknown>).configured_models as unknown[]))
      .toContainEqual(expect.objectContaining({ providerKey: imported.providerKey, id: imported.id }));

    const detached = runHelper({
      type: "removeFallback",
      providerKey: imported.providerKey,
      modelId: imported.id,
    }, config);
    const detachedSnapshot = parseHermesModelConfigResponse(detached.output);
    expect(detachedSnapshot.fallbacks).toEqual([
      expect.objectContaining({ providerKey: "second-provider", id: "second-backup" }),
    ]);
    expect(detachedSnapshot.configuredModels).toContainEqual(expect.objectContaining({
      providerKey: imported.providerKey,
      id: imported.id,
    }));

    const removed = runHelper({
      type: "remove",
      providerKey: imported.providerKey,
      modelId: imported.id,
    }, config);
    expect(parseHermesModelConfigResponse(removed.output).fallbacks).toEqual([
      expect.objectContaining({ providerKey: "second-provider", id: "second-backup" }),
    ]);
  });
});
