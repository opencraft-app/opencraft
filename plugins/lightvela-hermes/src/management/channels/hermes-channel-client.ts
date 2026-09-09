import type { HermesDebugCommandExecutor } from "../debug-command";
import { isExecCommandSucceeded, truncateExecOutput } from "../debug-command";
import { createHermesChannelCommands, type HermesQrPlatform } from "./hermes-channel-commands";

/**
 * Command protocol copied from @tencent/tea-sdk-lightclaw's Hermes command
 * factory. This module only replaces that package's browser-unsafe import
 * boundary; command spelling and escaping remain the console implementation.
 */
export type HermesChannelKind =
  | "qqbot"
  | "wecom"
  | "yuanbao"
  | "telegram"
  | "discord"
  | "slack"
  | "dingtalk";

export type HermesQrChannelKind = HermesQrPlatform;

export interface HermesQrStreamResult {
  platform?: string;
  status?: "pending" | "scanned" | "success" | "failed";
  url?: string;
  error_code?: string;
  [key: string]: unknown;
}

export function buildHermesChannelListCommand(): string {
  return createHermesChannelCommands().getListCommand();
}

export function buildHermesChannelDeleteCommand(platform: string): string {
  return createHermesChannelCommands().getDeleteCommand(platform);
}

export function buildHermesChannelConfigCommand(
  channel: HermesChannelKind,
  primary: string,
  secondary = "",
): string {
  const commands = createHermesChannelCommands();
  switch (channel) {
    case "qqbot":
      return commands.getQQBotConfigCommand({ appId: primary, clientSecret: secondary });
    case "wecom":
      return commands.getWecomConfigCommand({ appId: primary, clientSecret: secondary });
    case "yuanbao":
      return commands.getYuanbaoConfigCommand({ appKey: primary, appSecret: secondary });
    case "telegram":
      return commands.getTelegramConfigCommand({ botToken: primary });
    case "discord":
      return commands.getDiscordConfigCommand({ botToken: primary });
    case "slack":
      return commands.getSlackConfigCommand({ botToken: primary, appToken: secondary });
    case "dingtalk":
      return commands.getDingtalkConfigCommand({ clientId: primary, clientSecret: secondary });
  }
}

/** Direct copy of the 1.12.1 LightClaw command factory. */
export function buildHermesQrUrlCommand(params: {
  platform: HermesQrChannelKind;
  isI18n?: boolean;
  bindId?: string;
  ip?: string;
}): string {
  return createHermesChannelCommands().getQrUrlCommand(params);
}

/** Direct copy of mono2's NDJSON QR stream parser. */
export function parseHermesQrStream(stdout: string): HermesQrStreamResult | null {
  if (!stdout) return null;
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]!) as HermesQrStreamResult;
      if (!value?.platform) continue;
      if (typeof value.error_code === "string" && !value.status) {
        return { ...value, status: "failed" };
      }
      if ((value.status as string) === "error") {
        return { ...value, status: "failed" };
      }
      if (value.status === "pending" || value.status === "scanned" || value.status === "success" || value.status === "failed") {
        return value;
      }
    } catch {
      // Non-JSON progress lines are not protocol events.
    }
  }
  return null;
}

async function execute(
  executor: HermesDebugCommandExecutor,
  botId: string,
  command: string,
): Promise<string> {
  const result = await executor.execDebugCommand(botId, command, { timeoutMs: 120_000 });
  if (!isExecCommandSucceeded(result)) {
    throw new Error(truncateExecOutput(result.output, result.status));
  }
  return result.output;
}

export const listHermesChannels = (
  executor: HermesDebugCommandExecutor,
  botId: string,
) => execute(executor, botId, buildHermesChannelListCommand());

export async function configureHermesChannel(
  executor: HermesDebugCommandExecutor,
  botId: string,
  channel: HermesChannelKind,
  primary: string,
  secondary = "",
): Promise<void> {
  await execute(executor, botId, buildHermesChannelConfigCommand(channel, primary, secondary));
  await execute(executor, botId, "acli gateway restart");
}

export async function deleteHermesChannel(
  executor: HermesDebugCommandExecutor,
  botId: string,
  channel: string,
): Promise<void> {
  await execute(executor, botId, buildHermesChannelDeleteCommand(channel));
  await execute(executor, botId, "acli gateway restart");
}
