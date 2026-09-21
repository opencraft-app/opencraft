import type {
  AppServerModel,
  HermesModelCapabilities,
  HermesModelOptionsPayload,
  HermesModelProviderOption,
} from "./types";

const MODEL_SELECTION_PREFIX = "hermes-model:";

const HERMES_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const HERMES_REASONING_VALUES = new Set<string>(["none", ...HERMES_REASONING_EFFORTS]);
const HERMES_REASONING_DESCRIPTIONS: Readonly<Record<string, string>> = {
  none: "Disable reasoning for models that support it",
  minimal: "Fastest responses with minimal reasoning",
  low: "Faster responses with lighter reasoning",
  medium: "Balanced reasoning and response time",
  high: "More thorough reasoning for complex work",
  xhigh: "Extra reasoning depth for difficult work",
  max: "Maximum supported reasoning depth",
  ultra: "Highest Hermes reasoning setting",
};

function modelReasoningEfforts(
  model: string,
  capabilities: { supported_efforts?: string[] } | undefined,
): readonly string[] {
  const declared = (capabilities?.supported_efforts ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value, index, values) => HERMES_REASONING_VALUES.has(value) && values.indexOf(value) === index);
  if (declared.length > 0) return declared;
  // Provider-prefixed GLM 5.3 aliases share the mandatory low/high/max route.
  const normalized = model.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  if (/(?:^|-)glm-5-3(?:-|$)/u.test(normalized)) return ["low", "high", "max"];
  return HERMES_REASONING_EFFORTS;
}

function reasoningEfforts(
  model: string,
  capabilities: HermesModelCapabilities | undefined,
): AppServerModel["supportedReasoningEfforts"] {
  if (capabilities?.reasoning === false) return [];
  const declared = modelReasoningEfforts(model, capabilities);
  const enabled = capabilities?.can_disable_reasoning === false
    ? declared.filter((value) => value !== "none")
    : declared;
  const values = [
    ...(capabilities?.can_disable_reasoning === false || enabled.includes("none") ? [] : ["none"]),
    ...enabled,
  ];
  return values.map((reasoningEffort) => ({
    reasoningEffort,
    description: HERMES_REASONING_DESCRIPTIONS[reasoningEffort] ?? "Hermes reasoning effort",
  }));
}

export interface HermesModelSelection {
  readonly model: string;
  readonly provider: string | null;
}

export function encodeHermesModelSelection(
  provider: string,
  model: string,
): string {
  return `${MODEL_SELECTION_PREFIX}${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
}

export function decodeHermesModelSelection(
  value: unknown,
): HermesModelSelection | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!value.startsWith(MODEL_SELECTION_PREFIX)) {
    return { model: value.trim(), provider: null };
  }
  const encoded = value.slice(MODEL_SELECTION_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) {
    throw new Error("Invalid Hermes model selection");
  }
  try {
    const provider = decodeURIComponent(encoded.slice(0, separator)).trim();
    const model = decodeURIComponent(encoded.slice(separator + 1)).trim();
    if (provider === "" || model === "") throw new Error("empty selection");
    return { provider, model };
  } catch {
    throw new Error("Invalid Hermes model selection");
  }
}

export function modelSelectionFromExecution(
  model: unknown,
  provider: unknown,
): string {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  const normalizedProvider = typeof provider === "string" ? provider.trim() : "";
  if (normalizedModel === "") return "hermes";
  return normalizedProvider === ""
    ? normalizedModel
    : encodeHermesModelSelection(normalizedProvider, normalizedModel);
}

function modelId(value: string | { id?: string; name?: string }): string {
  return (typeof value === "string" ? value : value.id ?? value.name ?? "").trim();
}

function sameProviderIdentity(provider: HermesModelProviderOption, candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (normalized === "") return false;
  return [provider.slug, provider.name, ...(provider.aliases ?? [])]
    .some((identity) => typeof identity === "string" && identity.trim().toLowerCase() === normalized);
}

/**
 * Keep a resumed session's provider/model selection addressable through the
 * catalog's canonical slug. Hermes Desktop treats slug, display name, and
 * declared aliases as one provider identity; custom providers commonly expose
 * `custom:<name>` in a session and `<name>` in the picker.
 */
export function canonicalHermesModelSelection(
  payload: HermesModelOptionsPayload,
  model: unknown,
  provider: unknown,
): string {
  const raw = modelSelectionFromExecution(model, provider);
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  const normalizedProvider = typeof provider === "string" ? provider.trim() : "";
  if (normalizedModel === "" || normalizedProvider === "") return raw;
  const canonical = (payload.providers ?? []).find((candidate) =>
    sameProviderIdentity(candidate, normalizedProvider)
      && (candidate.models ?? []).some((entry) => modelId(entry) === normalizedModel),
  );
  return canonical === undefined ? raw : encodeHermesModelSelection(canonical.slug.trim(), normalizedModel);
}

export function mapHermesModelOptions(
  payload: HermesModelOptionsPayload,
): AppServerModel[] {
  const providers = (payload.providers ?? []).filter(
    (provider) =>
      typeof provider.slug === "string" &&
      provider.slug.trim() !== "" &&
      Array.isArray(provider.models),
  );
  const occurrences = new Map<string, number>();
  for (const provider of providers) {
    for (const rawModel of provider.models ?? []) {
      const normalized = modelId(rawModel);
      if (normalized !== "") {
        occurrences.set(normalized, (occurrences.get(normalized) ?? 0) + 1);
      }
    }
  }

  const result: AppServerModel[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const providerSlug = provider.slug.trim();
    const providerName = provider.name?.trim() || providerSlug;
    for (const rawModel of provider.models ?? []) {
      const model = modelId(rawModel);
      if (model === "") continue;
      const selection = encodeHermesModelSelection(providerSlug, model);
      if (seen.has(selection)) continue;
      seen.add(selection);
      const capabilities = provider.capabilities?.[model];
      const supportedReasoningEfforts = reasoningEfforts(model, capabilities);
      const duplicate = (occurrences.get(model) ?? 0) > 1;
      result.push({
        id: selection,
        model: selection,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: duplicate ? `${model} · ${providerName}` : model,
        description: provider.warning?.trim() || `Hermes via ${providerName}`,
        modelSpecialty: null,
        hidden: provider.authenticated === false,
        // Official Hermes Desktop presents the canonical Hermes ladder and
        // lets the provider transport clamp it to the wire vocabulary. A
        // mandatory route omits `none`; high is the conservative provider
        // default used when an old session was previously set to `none`.
        supportedReasoningEfforts,
        defaultReasoningEffort: (() => {
          const values = supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort);
          if (values.length === 0) return null;
          if (capabilities?.can_disable_reasoning === false) return values.includes("high") ? "high" : values[0]!;
          return values.includes("medium") ? "medium" : values.find((value) => value !== "none") ?? values[0]!;
        })(),
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault:
          providerSlug === payload.provider && model === payload.model,
      });
    }
  }
  return result;
}

function hermesModelSwitchToken(value: string): string {
  const token = value.trim();
  if (token === "" || /\s/u.test(token) || token.startsWith("-")) {
    throw new Error("Hermes model selection contains an invalid RPC token");
  }
  return token;
}

export function hermesModelSwitchArgument(
  selection: HermesModelSelection,
): string {
  return [
    hermesModelSwitchToken(selection.model),
    ...(selection.provider === null
      ? []
      : ["--provider", hermesModelSwitchToken(selection.provider)]),
    "--session",
  ].join(" ");
}
