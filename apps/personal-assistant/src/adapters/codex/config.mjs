import { isAbsolute } from "node:path";
import { lstatSync, readFileSync } from "node:fs";

/** Validated role selection; no credential reads during profile loading. */
export function resolveHarnesses(config = {}) {
  const value = config.harnesses ?? {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["assistant", "execution", "codex", "backgroundCodex"].includes(k))
  )
    throw new Error("Unknown harnesses configuration");
  const assistant = value.assistant ?? "pi",
    execution = value.execution ?? "pi";
  if (!["pi", "codex"].includes(assistant)) throw new Error("assistant harness must be pi or codex");
  if (!["pi", "codex"].includes(execution))
    throw new Error("Execution harness must be pi or codex; native checkpoint migration is not supported");
  if (assistant === "codex" || execution === "codex" || value.codex !== undefined) validateCodexConfig(value.codex);
  if (value.backgroundCodex !== undefined) validateCodexConfig(value.backgroundCodex);
  return {
    assistant,
    execution,
    ...(value.codex ? { codex: value.codex } : {}),
    ...(value.backgroundCodex ? { backgroundCodex: value.backgroundCodex } : {}),
  };
}
export function validateCodexConfig(config) {
  if (
    !config ||
    Object.keys(config).some(
      (k) =>
        ![
          "managed",
          "providerId",
          "binary",
          "baseUrl",
          "modelId",
          "credentialFile",
          "reasoningEffort",
          "structuredProtocol",
        ].includes(k),
    )
  )
    throw new Error("Explicit Codex binary, baseUrl and modelId are required");
  if (
    typeof config.binary !== "string" ||
    !isAbsolute(config.binary) ||
    typeof config.modelId !== "string" ||
    !/^[A-Za-z0-9_.:/-]{1,160}$/.test(config.modelId)
  )
    throw new Error("Invalid Codex binary or modelId");
  if (config.structuredProtocol !== undefined && !["selected-v2", "flat-v1"].includes(config.structuredProtocol))
    throw new Error("Invalid Codex structuredProtocol");
  if (
    config.reasoningEffort !== undefined &&
    !["none", "minimal", "low", "medium", "high", "xhigh"].includes(config.reasoningEffort)
  )
    throw new Error("Invalid Codex reasoningEffort");
  if (config.managed === true) {
    if (
      typeof config.providerId !== "string" ||
      !config.providerId ||
      config.providerId.length > 128 ||
      config.credentialFile !== undefined ||
      config.baseUrl !== undefined
    )
      throw Error("Managed Codex requires only a model reference");
    return config;
  }
  if (config.managed !== undefined || config.providerId !== undefined) throw Error("Invalid managed model reference");
  const url = new URL(config.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!loopback && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Codex requires HTTPS or explicit loopback HTTP without URL credentials");
  if (
    (!loopback && !config.credentialFile) ||
    (config.credentialFile !== undefined &&
      (typeof config.credentialFile !== "string" || !isAbsolute(config.credentialFile)))
  )
    throw new Error("A private absolute Codex credentialFile is required");
  return config;
}
export function readCodexKey(config) {
  if (!config.credentialFile) return undefined;
  const stat = lstatSync(config.credentialFile);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096)
    throw new Error("Codex credentialFile must be an owner-only regular file (0600)");
  const key = readFileSync(config.credentialFile, "utf8").trim();
  if (!key || /\s/.test(key)) throw new Error("Codex credentialFile must contain only the API key");
  return key;
}
