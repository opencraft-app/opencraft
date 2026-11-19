export const composerAgentBrands = {
  codex: { brand: "codex", name: "Codex" },
  cursor: { brand: "cursor", name: "Cursor" },
  "claude-code": { brand: "claude", name: "Claude Code" },
  codebuddy: { brand: "codebuddy", name: "CodeBuddy" },
  pi: { brand: "pi", name: "Pi" },
} as const;

export type ComposerAgentBrand = (typeof composerAgentBrands)[keyof typeof composerAgentBrands]["brand"];

const agentNameByBrand = new Map(Object.values(composerAgentBrands).map(item => [item.brand, item.name.toLocaleLowerCase()]));

/** A host catalog titled exactly like an Agent already listed is the built-in engine, not a second Agent. */
export function omitDuplicateHostAgents<T extends { readonly agentId: string; readonly label: string; readonly brand?: ComposerAgentBrand }>(sources: readonly T[]): T[] {
  const present = new Set(sources.flatMap(source => {
    const name = source.brand ? agentNameByBrand.get(source.brand) : undefined;
    return name ? [name] : [];
  }));
  return sources.filter(source => (source.agentId !== "host" && source.agentId !== "api") || !present.has(source.label.trim().toLocaleLowerCase()));
}

export function composerAgentBrand(agentId: string | null | undefined): ComposerAgentBrand | undefined {
  return agentId && agentId in composerAgentBrands ? composerAgentBrands[agentId as keyof typeof composerAgentBrands].brand : undefined;
}
