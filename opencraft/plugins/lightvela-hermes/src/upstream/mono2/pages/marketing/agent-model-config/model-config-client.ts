// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  HERMES_MODEL_CONFIG_JSON_END,
  HERMES_MODEL_CONFIG_JSON_START,
  buildHermesModelConfigCommand,
  type HermesConnectionProbeResult,
  type HermesConfiguredModel,
  type HermesCredentialEnvelope,
  type HermesCredentialEnvelopePreparation,
  type HermesModelConfigAction,
  type HermesModelConfigSnapshot,
} from "./hermes-model-config-command";

export type { HermesCanonicalApiMode, HermesConfiguredModel, HermesConnectionProbeResult, HermesConnectionProbeStrategy, HermesModelConfigAction, HermesModelConfigSnapshot, HermesModelProbeResult, ModelDiscoveryStrategy, ModelProviderOption } from "./hermes-model-config-command";
export { buildHermesModelConfigCommand } from "./hermes-model-config-command";

interface DebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
}

export type HermesModelConfigExecDebugCommand = (
  botId: string,
  command: string,
  options: { timeoutMs: number },
) => Promise<DebugCommandResult>;

export class HermesModelConfigResponseError extends Error {
  constructor(
    public readonly code: "command_failed" | "invalid_response" | "helper_error",
    message: string,
  ) {
    super(message);
    this.name = "HermesModelConfigResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readText(value: unknown, field: string, required = true): string {
  if (typeof value !== "string") {
    throw new HermesModelConfigResponseError("invalid_response", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw new HermesModelConfigResponseError("invalid_response", `${field} is required`);
  }
  return normalized;
}

function parseModel(value: unknown, field: string): HermesConfiguredModel {
  if (!isRecord(value)) {
    throw new HermesModelConfigResponseError("invalid_response", `${field} must be an object`);
  }
  if (value.requiresSetup !== undefined && typeof value.requiresSetup !== "boolean") {
    throw new HermesModelConfigResponseError("invalid_response", `${field}.requiresSetup must be a boolean`);
  }
  const requiresSetup = value.requiresSetup === true;
  const model: HermesConfiguredModel = {
    id: readText(value.id, `${field}.id`, !requiresSetup),
    providerKey: readText(value.providerKey, `${field}.providerKey`),
    providerName: readText(value.providerName, `${field}.providerName`),
    baseUrl: readText(value.baseUrl, `${field}.baseUrl`, false),
    apiMode: readText(value.apiMode, `${field}.apiMode`, false),
    keyEnv: readText(value.keyEnv, `${field}.keyEnv`, false),
  };
  if (value.routeBaseUrl !== undefined) {
    model.routeBaseUrl = readText(value.routeBaseUrl, `${field}.routeBaseUrl`, false);
  }
  if (value.canDelete !== undefined) {
    if (typeof value.canDelete !== "boolean") {
      throw new HermesModelConfigResponseError("invalid_response", `${field}.canDelete must be a boolean`);
    }
    model.canDelete = value.canDelete;
  }
  if (value.requiresSetup !== undefined) model.requiresSetup = value.requiresSetup;
  return model;
}

function parseSnapshot(value: unknown): HermesModelConfigSnapshot {
  if (!isRecord(value)) {
    throw new HermesModelConfigResponseError("invalid_response", "snapshot must be an object");
  }
  const parseOptionalModel = (item: unknown, field: string) => item === null ? null : parseModel(item, field);
  if (!Array.isArray(value.configuredModels)) {
    throw new HermesModelConfigResponseError("invalid_response", "configuredModels must be an array");
  }
  if (!Array.isArray(value.fallbacks)) {
    throw new HermesModelConfigResponseError("invalid_response", "fallbacks must be an array");
  }
  const probeSucceeded = value.probeSucceeded;
  if (probeSucceeded !== undefined && typeof probeSucceeded !== "boolean") {
    throw new HermesModelConfigResponseError("invalid_response", "probeSucceeded must be a boolean");
  }
  const snapshot: HermesModelConfigSnapshot = {
    primary: parseOptionalModel(value.primary, "primary"),
    fallbacks: value.fallbacks.map((model, index) => parseModel(model, `fallbacks.${index}`)),
    configuredModels: value.configuredModels.map((model, index) => parseModel(model, `configuredModels.${index}`)),
  };
  if (value.probedModels !== undefined) {
    if (!Array.isArray(value.probedModels) || value.probedModels.some((model) => typeof model !== "string" || !model.trim())) {
      throw new HermesModelConfigResponseError("invalid_response", "probedModels must be an array of model IDs");
    }
    snapshot.probedModels = [...new Set(value.probedModels.map((model) => model.trim()))];
    snapshot.probeSucceeded = probeSucceeded ?? true;
  }
  return snapshot;
}

function parseHermesModelConfigPayload(output: string): Record<string, unknown> {
  const start = output.indexOf(HERMES_MODEL_CONFIG_JSON_START);
  const end = output.indexOf(HERMES_MODEL_CONFIG_JSON_END, start + HERMES_MODEL_CONFIG_JSON_START.length);
  if (start < 0 || end < 0) {
    throw new HermesModelConfigResponseError("invalid_response", "Hermes model config response markers are missing");
  }
  const serialized = output.slice(start + HERMES_MODEL_CONFIG_JSON_START.length, end).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new HermesModelConfigResponseError("invalid_response", "Hermes model config response contains invalid JSON");
  }
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new HermesModelConfigResponseError("invalid_response", "Hermes model config response is invalid");
  }
  if (!payload.ok) {
    throw new HermesModelConfigResponseError("helper_error", readText(payload.error, "error"));
  }
  return payload;
}

export function parseHermesModelConfigResponse(output: string): HermesModelConfigSnapshot {
  return parseSnapshot(parseHermesModelConfigPayload(output).snapshot);
}

export function parseHermesCredentialEnvelopePreparation(output: string): HermesCredentialEnvelopePreparation {
  const payload = parseHermesModelConfigPayload(output);
  if (!isRecord(payload.credentialEnvelope)) {
    throw new HermesModelConfigResponseError("invalid_response", "credentialEnvelope must be an object");
  }
  return {
    token: readText(payload.credentialEnvelope.token, "credentialEnvelope.token"),
    publicKey: readText(payload.credentialEnvelope.publicKey, "credentialEnvelope.publicKey"),
  };
}

export function parseHermesConnectionProbeResponse(output: string): HermesConnectionProbeResult {
  const value = parseHermesModelConfigPayload(output).connection;
  if (!isRecord(value)) {
    throw new HermesModelConfigResponseError("invalid_response", "connection must be an object");
  }
  if (typeof value.success !== "boolean") {
    throw new HermesModelConfigResponseError("invalid_response", "connection.success must be a boolean");
  }
  const result: HermesConnectionProbeResult = {
    success: value.success,
    provider: readText(value.provider, "connection.provider"),
    model: readText(value.model, "connection.model"),
    baseUrl: readText(value.baseUrl, "connection.baseUrl"),
  };
  if (value.timeMs !== undefined) {
    if (typeof value.timeMs !== "number" || !Number.isFinite(value.timeMs) || value.timeMs < 0) {
      throw new HermesModelConfigResponseError("invalid_response", "connection.timeMs must be a non-negative number");
    }
    result.timeMs = value.timeMs;
  }
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== "string" && typeof value.errorCode !== "number") {
      throw new HermesModelConfigResponseError("invalid_response", "connection.errorCode must be a string or number");
    }
    result.errorCode = value.errorCode;
  }
  if (value.errorMessage !== undefined) {
    result.errorMessage = readText(value.errorMessage, "connection.errorMessage");
  }
  return result;
}

function bytesToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sealHermesCredential(
  preparation: HermesCredentialEnvelopePreparation,
  credential: string,
): Promise<HermesCredentialEnvelope> {
  const encodedKey = preparation.publicKey
    .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  const binaryKey = atob(encodedKey);
  const keyBytes = Uint8Array.from(binaryKey, (character) => character.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    keyBytes,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const credentialBytes = new TextEncoder().encode(credential);
  const encryptedChunks: string[] = [];
  for (let offset = 0; offset < credentialBytes.length; offset += 190) {
    const encrypted = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      credentialBytes.slice(offset, offset + 190),
    );
    encryptedChunks.push(bytesToBase64(encrypted));
  }
  if (!encryptedChunks.length) {
    throw new HermesModelConfigResponseError("invalid_response", "credential is required");
  }
  return { token: preparation.token, ciphertext: encryptedChunks.join(".") };
}

function commandSucceeded(result: DebugCommandResult): boolean {
  return result.exitCode === 0 && /^(succeeded|success)$/i.test(result.status.trim());
}

const timeoutFor = (action: HermesModelConfigAction): number => (
  action.type === "probe" || action.type === "connectivityProbe" || action.type === "add" ? 120_000 : 60_000
);

export function createHermesModelConfigClient(
  execDebugCommand: HermesModelConfigExecDebugCommand,
  botId: string,
  profileId?: string,
) {
  const executeCommand = async (action: HermesModelConfigAction): Promise<DebugCommandResult> => {
    const result = await execDebugCommand(
      botId,
      buildHermesModelConfigCommand(action, profileId),
      { timeoutMs: timeoutFor(action) },
    );
    if (!commandSucceeded(result)) {
      throw new HermesModelConfigResponseError("command_failed", "Model configuration command failed");
    }
    return result;
  };

  const execute = async (action: HermesModelConfigAction): Promise<HermesModelConfigSnapshot> => {
    try {
      const result = await executeCommand(action);
      return parseHermesModelConfigResponse(result.output);
    } catch (error) {
      if (error instanceof HermesModelConfigResponseError) {
        throw error;
      }
      throw new HermesModelConfigResponseError("command_failed", "Model configuration command failed");
    }
  };

  const prepareCredentialEnvelope = async (apiKey: string): Promise<HermesCredentialEnvelope> => {
    const credentialLength = new TextEncoder().encode(apiKey).length;
    if (!credentialLength || credentialLength > 190 * 64) {
      throw new HermesModelConfigResponseError("invalid_response", "Model configuration credential is invalid");
    }
    const preparationResult = await executeCommand({ type: "prepareCredentialEnvelope" });
    const preparation = parseHermesCredentialEnvelopePreparation(preparationResult.output);
    return sealHermesCredential(preparation, apiKey);
  };

  const executeWithCredential = async (
    apiKey: string,
    createAction: (credentialEnvelope: HermesCredentialEnvelope) => Extract<HermesModelConfigAction, { type: "probe" | "add" }>,
  ): Promise<HermesModelConfigSnapshot> => {
    try {
      const credentialEnvelope = await prepareCredentialEnvelope(apiKey);
      return await execute(createAction(credentialEnvelope));
    } catch (error) {
      if (error instanceof HermesModelConfigResponseError) throw error;
      throw new HermesModelConfigResponseError("command_failed", "Model configuration command failed");
    }
  };

  return {
    read: () => execute({ type: "read" }),
    probe: async (input: { apiKey: string; baseUrl: string; apiMode?: string }) => {
      const snapshot = await executeWithCredential(input.apiKey, (credentialEnvelope) => ({
        type: "probe", credentialEnvelope, baseUrl: input.baseUrl, apiMode: input.apiMode,
      }));
      return {
        models: snapshot.probedModels ?? [],
        succeeded: snapshot.probeSucceeded ?? true,
      };
    },
    testConnection: async (input: { apiKey: string; model: HermesConfiguredModel; strategy?: "model_list" | "model_request" }) => {
      try {
        const credentialEnvelope = await prepareCredentialEnvelope(input.apiKey);
        const result = await executeCommand({
          type: "connectivityProbe",
          credentialEnvelope,
          model: input.model,
          strategy: input.strategy,
        });
        return parseHermesConnectionProbeResponse(result.output);
      } catch (error) {
        if (error instanceof HermesModelConfigResponseError) throw error;
        throw new HermesModelConfigResponseError("command_failed", "Model configuration command failed");
      }
    },
    add: (input: { apiKey: string; model: HermesConfiguredModel; purpose: "primary" | "fallback" | "idle"; discoverModels?: boolean }) => (
      executeWithCredential(input.apiKey, (credentialEnvelope) => ({
        type: "add", credentialEnvelope, model: input.model, purpose: input.purpose, discoverModels: input.discoverModels,
      }))
    ),
    assign: (input: Omit<Extract<HermesModelConfigAction, { type: "assign" }>, "type">) => execute({ type: "assign", ...input }),
    removeFallback: (input: Omit<Extract<HermesModelConfigAction, { type: "removeFallback" }>, "type">) => (
      execute({ type: "removeFallback", ...input })
    ),
    remove: (input: Omit<Extract<HermesModelConfigAction, { type: "remove" }>, "type">) => execute({ type: "remove", ...input }),
  };
}
