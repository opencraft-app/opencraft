import type {
  AppServerModel,
  HermesModelOptionsPayload,
} from "./types";

const MODEL_SELECTION_PREFIX = "hermes-model:";

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
    for (const model of provider.models ?? []) {
      const normalized = String(model).trim();
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
      const model = String(rawModel).trim();
      if (model === "") continue;
      const selection = encodeHermesModelSelection(providerSlug, model);
      if (seen.has(selection)) continue;
      seen.add(selection);
      const capabilities = provider.capabilities?.[model];
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
        // Hermes advertises whether reasoning exists, but deliberately does
        // not publish a trustworthy effort enum. Do not fabricate one here.
        supportedReasoningEfforts: [],
        defaultReasoningEffort: capabilities?.reasoning === false ? "none" : "medium",
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

function quoteHermesArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function hermesModelSwitchArgument(
  selection: HermesModelSelection,
): string {
  return [
    quoteHermesArgument(selection.model),
    ...(selection.provider === null
      ? []
      : ["--provider", quoteHermesArgument(selection.provider)]),
    "--session",
  ].join(" ");
}
