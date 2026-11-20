import type { HistoryImportAgentId, OnboardingAgentSnapshot } from "@opencraft/appserver-protocol";

/** New Hosts declare support; older Hosts keep their two implemented sources. */
export function canImportAgentHistory(agent: OnboardingAgentSnapshot): agent is OnboardingAgentSnapshot & { id: HistoryImportAgentId } {
  return agent.installed && (agent.id !== "codebuddy-ide" || agent.authenticated === true && agent.workspaceTrusted !== false && agent.connectionRequired !== true)
    && (agent.historyImport === true || agent.historyImport === undefined && (agent.id === "codex" || agent.id === "cursor"));
}
export const historyAgentLabel = (id: string) => (({ codex: "Codex", cursor: "Cursor", claude: "Claude Code", codebuddy: "CodeBuddy CLI", "codebuddy-ide": "CodeBuddy IDE", pi: "Pi", dsh: "DSH" } as Readonly<Record<string, string>>))[id] ?? id;
