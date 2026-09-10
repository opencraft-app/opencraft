// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
export const DEFAULT_HERMES_AGENT_ID = "main";
const HERMES_DEFAULT_PROFILE_ID = "default";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function toHermesNativeProfileId(profileId: string): string {
  return profileId === DEFAULT_HERMES_AGENT_ID ? HERMES_DEFAULT_PROFILE_ID : profileId;
}

export function withHermesAgent(
  command: string,
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  return `${command} --agent ${shellQuote(agentId)}`;
}

export function withHermesAgentCompatibility(
  command: string,
  capabilityHelpCommand: string,
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  const scopedCommand = withHermesAgent(command, agentId);
  return `if ${capabilityHelpCommand} --help 2>&1 | grep -q -- '--agent'; then ${scopedCommand}; else ${command}; fi`;
}

export function getHermesChannelStatusCommand(
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  return withHermesAgent("acli channel status", agentId);
}

export function getHermesProfileRootCommand(
  agentId: string = DEFAULT_HERMES_AGENT_ID,
  variableName = "HERMES_PROFILE_ROOT",
): string {
  const base = "${HERMES_HOME:-$HOME/.hermes}";
  if (agentId === DEFAULT_HERMES_AGENT_ID) return `${variableName}="${base}"`;
  return `${variableName}="${base}/profiles/"${shellQuote(agentId)}`;
}

export function withHermesProfile(
  command: string,
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  return `hermes -p ${shellQuote(toHermesNativeProfileId(agentId))} ${command}`;
}
