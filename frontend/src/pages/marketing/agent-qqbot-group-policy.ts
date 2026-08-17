import type { DebugExecCommandLifecycle } from "@/pages/marketing/agent-tat-adapter";

export const QQBOT_GROUP_POLICY_OPEN_COMMAND = "hermes config set platforms.qqbot.extra.group_policy open";

const QQBOT_MANUAL_BIND_COMMAND_PATTERN = /\bacli\s+configure\s+gateway\s+qqbot\b/i;
const QQBOT_QR_BIND_COMMAND_PATTERN = /\bacli\s+gateway\s+qr-url\b/i;
const QQBOT_QR_PLATFORM_PATTERN = /(?:^|\s)--platform(?:=|\s+)qqbot(?:\s|$)/i;

function normalizeCommandLine(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function hasInjectedGroupPolicy(command: string): boolean {
  return command
    .split(/\r?\n/)
    .some((line) => normalizeCommandLine(line) === QQBOT_GROUP_POLICY_OPEN_COMMAND);
}

export function isQqbotGroupPolicyOpenCommand(command: string): boolean {
  return normalizeCommandLine(command) === QQBOT_GROUP_POLICY_OPEN_COMMAND;
}

export function isQqbotConnectCommand(command: string): boolean {
  if (isQqbotGroupPolicyOpenCommand(command)) return false;
  if (QQBOT_MANUAL_BIND_COMMAND_PATTERN.test(command)) return true;
  return QQBOT_QR_BIND_COMMAND_PATTERN.test(command) && QQBOT_QR_PLATFORM_PATTERN.test(command);
}

export function buildQqbotGroupPolicyInjectedCommand(command: string): string {
  if (hasInjectedGroupPolicy(command)) return command;
  return ["set -e", QQBOT_GROUP_POLICY_OPEN_COMMAND, command].join("\n");
}

export function createQqbotGroupPolicyCommandLifecycle(): DebugExecCommandLifecycle {
  return {
    transformCommand: ({ command }) => {
      if (!isQqbotConnectCommand(command)) return undefined;
      return buildQqbotGroupPolicyInjectedCommand(command);
    },
  };
}
