import type { ModelMapping } from "@/lib/queries/use-model-mappings";
import type { Plan } from "@/lib/queries/use-plans";
import type { Provider } from "@/lib/queries/use-providers";

function normalizeModelName(value: string) {
  return value.trim().toLowerCase();
}

function providerSupportsModel(provider: Provider, model: string) {
  if (provider.status !== "active") {
    return false;
  }

  return (provider.supported_models ?? []).some(
    (supportedModel) => normalizeModelName(supportedModel) === normalizeModelName(model)
  );
}

function matchesModelPattern(pattern: string, model: string) {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern.includes("*")) {
    return normalizeModelName(normalizedPattern) === normalizeModelName(model);
  }

  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(model.trim());
}

function mappingCanRouteModel(
  mapping: ModelMapping,
  providersById: Map<string, Provider>,
  model: string
) {
  if (!mapping.is_active || !matchesModelPattern(mapping.model_pattern, model)) {
    return false;
  }

  const provider = providersById.get(mapping.provider_id);
  if (!provider || provider.status !== "active") {
    return false;
  }

  const supportedModels = provider.supported_models ?? [];
  if (supportedModels.length === 0) {
    return true;
  }

  return providerSupportsModel(provider, model);
}

export function getPlayableModels(
  plans: Plan[] | undefined,
  providers: Provider[] | undefined,
  mappings: ModelMapping[] | undefined
) {
  if (!plans?.length) {
    return [];
  }

  const activeProviders = (providers ?? []).filter((provider) => provider.status === "active");
  const providersById = new Map(activeProviders.map((provider) => [provider.id, provider]));
  const result = new Map<string, string>();

  for (const plan of plans) {
    for (const allowedModel of plan.allowed_models ?? []) {
      const normalizedModel = normalizeModelName(allowedModel);
      if (!normalizedModel || result.has(normalizedModel)) {
        continue;
      }

      const supportedByProvider = activeProviders.some((provider) =>
        providerSupportsModel(provider, allowedModel)
      );
      const supportedByMapping = (mappings ?? []).some((mapping) =>
        mappingCanRouteModel(mapping, providersById, allowedModel)
      );

      if (supportedByProvider || supportedByMapping) {
        result.set(normalizedModel, allowedModel.trim());
      }
    }
  }

  return Array.from(result.values()).sort((left, right) => left.localeCompare(right));
}
