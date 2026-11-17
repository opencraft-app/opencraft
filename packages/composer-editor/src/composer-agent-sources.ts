import type { AgentBrand } from "@opencraft/design-system-web/action-icons";
import type { IntlShape } from "@opencraft/i18n";
import type { ComposerAgentModelGroup, ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";

const brands: Record<string, { brand: AgentBrand; name: string }> = {
  codex: { brand: "codex", name: "Codex" }, cursor: { brand: "cursor", name: "Cursor" },
  "claude-code": { brand: "claude", name: "Claude Code" }, codebuddy: { brand: "codebuddy", name: "CodeBuddy" },
};

export interface ComposerAgentSource {
  readonly id: string;
  readonly label: string;
  readonly brand?: AgentBrand;
  readonly group: Omit<ComposerAgentModelGroup, "select"> & { readonly select?: ComposerAgentModelGroup["select"] };
  readonly models: ComposerModelOption[];
}

/** Agent identity comes from the Host catalog, scoped by its execution owner. */
export function composerAgentSources(catalog: ComposerSelectionCatalog | undefined, intl: IntlShape): ComposerAgentSource[] {
  const apiLabel = intl.formatMessage({ id: "composer.model.api", defaultMessage: "API models" });
  const groups = catalog?.agentGroups?.length ? catalog.agentGroups : [{ id: "active", label: "", active: true,
    models: catalog?.models ?? [], loading: catalog?.isFetching, error: catalog?.modelError, retry: catalog?.retryModels }];

  const sources: ComposerAgentSource[] = [];
  for (const group of groups) {
    const scoped = new Map<string, ComposerAgentSource>();
    for (const model of group.models) {
      const identity = model.agentId ? brands[model.agentId] : undefined;
      const key = model.agentId ?? "host";
      let source = scoped.get(key);
      if (!source) {
        const name = key === "dsh" ? apiLabel : model.agentLabel || group.label || intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" });
        source = { id: `${group.id}:${key}`, label: groups.length > 1 && group.label !== name ? `${name} · ${group.label}` : name,
          brand: identity?.brand, group, models: [] };
        scoped.set(key, source); sources.push(source);
      }
      source.models.push(model);
    }
    if (!scoped.size && (group.loading || group.error || !catalog?.onConfigureAgents)) sources.push({ id: `${group.id}:api`, label: group.label || apiLabel, group, models: [] });
  }
  const brandOrder: Record<string, number> = { codex: 0, claude: 1, cursor: 2, codebuddy: 3 };
  sources.sort((left, right) => (brandOrder[left.brand ?? ""] ?? 4) - (brandOrder[right.brand ?? ""] ?? 4));
  return sources;
}
