export const composerAgentBrands = {
  codex: { brand: "codex", name: "Codex" },
  cursor: { brand: "cursor", name: "Cursor" },
  "claude-code": { brand: "claude", name: "Claude Code" },
  codebuddy: { brand: "codebuddy", name: "CodeBuddy" },
  pi: { brand: "pi", name: "Pi" },
} as const;

export type ComposerAgentBrand = (typeof composerAgentBrands)[keyof typeof composerAgentBrands]["brand"];

export function composerAgentBrand(agentId: string | null | undefined): ComposerAgentBrand | undefined {
  return agentId && agentId in composerAgentBrands ? composerAgentBrands[agentId as keyof typeof composerAgentBrands].brand : undefined;
}
