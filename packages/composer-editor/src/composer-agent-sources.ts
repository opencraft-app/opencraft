import type { AgentBrand } from "@opencraft/design-system-web/action-icons";
import type { IntlShape } from "@opencraft/i18n";
import type { ComposerAgentModelGroup, ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";

const brands: Record<string, { brand: AgentBrand; name: string }> = {
  codex: { brand: "codex", name: "Codex" }, cursor: { brand: "cursor", name: "Cursor" },
  "claude-code": { brand: "claude", name: "Claude Code" }, codebuddy: { brand: "codebuddy", name: "CodeBuddy" },
  "codebuddy-ide": { brand: "codebuddy", name: "CodeBuddy IDE" },
};

export function composerAgentBrand(agentId?: string | null, modelValue?: string | null): AgentBrand | undefined {
  if (agentId && brands[agentId]) return brands[agentId].brand;
  if (!modelValue) return undefined;
  if (modelValue.startsWith("codex:")) return "codex";
  if (modelValue.startsWith("cursor:")) return "cursor";
  if (modelValue.startsWith("claude-code:")) return "claude";
  if (modelValue.startsWith("codebuddy:") || modelValue.startsWith("codebuddy-ide:")) return "codebuddy";
  return undefined;
}

export interface ComposerAgentSource {
  readonly id: string;
  readonly label: string;
  readonly agentLabel: string;
  readonly brand?: AgentBrand;
  readonly group: Omit<ComposerAgentModelGroup, "select"> & { readonly select?: ComposerAgentModelGroup["select"] };
  readonly models: ComposerModelOption[];
}

/** Agent identity comes from the Host catalog, scoped by its execution owner. */
export function composerAgentSources(catalog: ComposerSelectionCatalog | undefined, intl: IntlShape): ComposerAgentSource[] {
  const apiLabel = intl.formatMessage({ id: "composer.model.api", defaultMessage: "API models" });
  const groups: readonly (Omit<ComposerAgentModelGroup, "select"> & { readonly select?: ComposerAgentModelGroup["select"] })[] = catalog?.agentGroups?.length
    ? catalog.agentGroups
    : [{ id: "active", label: "", active: true,
      models: catalog?.models ?? [], loading: catalog?.isFetching, error: catalog?.modelError, retry: catalog?.retryModels }];

  const machineOrder = new Map<string, number>();
  for (const group of groups) {
    const machineKey = group.machineId ?? group.id;
    if (!machineOrder.has(machineKey)) machineOrder.set(machineKey, machineOrder.size);
  }
  const multiMachine = machineOrder.size > 1 && groups.some(group => Boolean(group.machineLabel));

  const sources: ComposerAgentSource[] = [];
  for (const group of groups) {
    const scoped = new Map<string, ComposerAgentSource>();
    for (const model of group.models) {
      const identity = model.agentId ? brands[model.agentId] : undefined;
      const key = model.agentId ?? "host";
      let source = scoped.get(key);
      if (!source) {
        const name = key === "dsh" ? apiLabel : model.agentLabel || group.label || intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" });
        source = {
          id: `${group.id}:${key}`,
          agentLabel: name,
          label: !multiMachine && groups.length > 1 && group.label !== name ? `${name} · ${group.label}` : name,
          brand: identity?.brand,
          group,
          models: [],
        };
        scoped.set(key, source); sources.push(source);
      }
      source.models.push(model);
    }
    if (!scoped.size && (group.loading || group.error || !catalog?.onConfigureAgents)) {
      const fallbackLabel = multiMachine ? apiLabel : (group.label || apiLabel);
      sources.push({ id: `${group.id}:api`, agentLabel: apiLabel, label: fallbackLabel, group, models: [] });
    }
  }
  const brandOrder: Record<string, number> = { codex: 0, claude: 1, cursor: 2, codebuddy: 3 };
  sources.sort((left, right) => {
    const leftMachine = machineOrder.get(left.group.machineId ?? left.group.id) ?? 0;
    const rightMachine = machineOrder.get(right.group.machineId ?? right.group.id) ?? 0;
    if (leftMachine !== rightMachine) return leftMachine - rightMachine;
    return (brandOrder[left.brand ?? ""] ?? 4) - (brandOrder[right.brand ?? ""] ?? 4);
  });
  return sources;
}
