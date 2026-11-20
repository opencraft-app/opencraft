import type { OnboardingAgentSnapshot } from "@opencraft/appserver-protocol";
import { AgentBrandIcon, AgentIcon, ModelIcon, type AgentBrand } from "@opencraft/design-system-web/action-icons";

export interface AgentCatalogModel {
  readonly agentId: string;
  readonly agentLabel?: string;
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}
export interface AgentDirectoryEntry {
  readonly id: string;
  readonly label: string;
  readonly native?: OnboardingAgentSnapshot;
  readonly models: readonly AgentCatalogModel[];
  readonly ready: boolean;
}

/** Server catalogs and installation observations project into one presentation. */
export function projectAgentDirectory(models: readonly AgentCatalogModel[], native: readonly OnboardingAgentSnapshot[], fallbackName: (id: string) => string): AgentDirectoryEntry[] {
  const entries = new Map<string, AgentDirectoryEntry>();
  for (const model of models) {
    // Internal built-in API-model harness (`dsh`) is configured under Model Configuration,
    // never exposed as a standalone client Agent. External local DSH uses `dsh-acp`.
    if (model.agentId === "dsh") continue;
    const entry = entries.get(model.agentId);
    entries.set(model.agentId, { id: model.agentId, label: model.agentLabel || fallbackName(model.agentId),
      models: [...(entry?.models ?? []), model], ready: true });
  }
  for (const agent of native) {
    const id = agent.engineId ?? agent.id, existing = entries.get(id);
    entries.set(id, { id, label: agent.displayName || existing?.label || fallbackName(agent.id), native: agent,
      models: existing?.models ?? [], ready: agent.installed && agent.authenticated === true && agent.connectionRequired !== true && agent.workspaceTrusted !== false && agent.activity?.phase !== "running" });
  }
  return [...entries.values()];
}

export function AgentIdentityIcon({ id, size = 18 }: { readonly id: string; readonly size?: number }) {
  const brand: AgentBrand | undefined = ({ codex: "codex", "codex-bridge": "codex", cursor: "cursor", "claude-code": "claude", claude: "claude", gemini: "gemini", codebuddy: "codebuddy", "codebuddy-ide": "codebuddy" } as Readonly<Record<string, AgentBrand>>)[id];
  return brand ? <AgentBrandIcon agent={brand} size={size} /> : id === "pi" || id === "pi-bridge" || id === "pi-cli" ? <ModelIcon size={size} /> : <AgentIcon size={size} />;
}
