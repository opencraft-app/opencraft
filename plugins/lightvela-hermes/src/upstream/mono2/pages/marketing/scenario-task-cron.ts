// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { shellQuote, type CronJob } from "../../lib/hermes-cron-client";

const CONNECTED_CHANNEL_STATUSES = new Set(["connected", "enabled", "running", "ready"]);

const CHANNEL_LABELS: Record<string, string> = {
  dingtalk: "钉钉",
  discord: "Discord",
  feishu: "飞书",
  lark: "飞书",
  qq: "QQ",
  qqbot: "QQ",
  slack: "Slack",
  telegram: "Telegram",
  tg: "Telegram",
  wechat: "微信",
  wecom: "企业微信",
  weixin: "微信",
  whatsapp: "WhatsApp",
};

export function parseEnabledScenarioChannels(output: string): Set<string> | null {
  const payload = parseJsonObjectFromOutput(output);
  if (!payload || typeof payload !== "object") return null;
  const root = payload as {
    channels?: unknown;
    data?: { channels?: unknown; platforms?: unknown };
    platforms?: unknown;
  };
  const collection = root.data?.platforms ?? root.data?.channels ?? root.platforms ?? root.channels;
  const entries = normalizeChannelCollection(collection);
  return new Set(
    entries
      .filter((entry) => entry.enabled)
      .map((entry) => normalizeScenarioChannelKey(entry.channel)),
  );
}

export function formatScenarioChannelLabel(channel: string): string {
  const key = normalizeScenarioChannelKey(channel.split(":")[0] ?? channel);
  return CHANNEL_LABELS[key] ?? channel.trim();
}

export function isScenarioOnceCronJob(job: CronJob): boolean {
  const kind = job.schedule.kind.toLowerCase();
  const display = (job.schedule.display || job.schedule.expr || "").trim().toLowerCase();
  return kind === "once" || display.startsWith("once") || /^\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}/.test(display);
}

export function buildScenarioSendCommands(deliver: string, message: string): string[] {
  return deliver
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target && target !== "local")
    .map((target) => ["hermes", "send", "--to", shellQuote(target), shellQuote(message)].join(" "));
}

function parseJsonObjectFromOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeChannelCollection(collection: unknown): Array<{ channel: string; enabled: boolean }> {
  const rawItems = Array.isArray(collection)
    ? collection
    : collection && typeof collection === "object"
      ? Object.entries(collection as Record<string, unknown>).map(([name, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return { name, ...(value as Record<string, unknown>) };
        }
        return {
          name,
          enabled: value === true,
          status: typeof value === "string" ? value : undefined,
          value: typeof value === "string" ? undefined : value,
        };
      })
      : [];

  return rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as {
      channel?: unknown;
      enabled?: unknown;
      name?: unknown;
      status?: unknown;
      value?: unknown;
    };
    const nestedValue = "value" in item && item.value && typeof item.value === "object"
      ? item.value as Record<string, unknown>
      : null;
    const channel = typeof item.channel === "string"
      ? item.channel
      : typeof item.name === "string"
        ? item.name
        : typeof item.value === "string"
          ? item.value
          : "";
    const statusSource = typeof item.status === "string"
      ? item.status
      : typeof nestedValue?.status === "string"
        ? nestedValue.status
        : "";
    const status = statusSource.toLowerCase();
    const enabled = item.enabled === true
      || nestedValue?.enabled === true
      || CONNECTED_CHANNEL_STATUSES.has(status);
    return channel ? [{ channel, enabled }] : [];
  });
}

function normalizeScenarioChannelKey(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (["wechat", "weixin", "openclaw-weixin", "openclaw-wechat"].includes(normalized)) return "weixin";
  if (["qq", "qqbot", "qq-bot", "qqbotplugin", "openclaw-qqbot", "openclaw-qq"].includes(normalized)) return "qqbot";
  if (["wecom", "wework", "work-weixin", "work-wechat", "openclaw-wecom"].includes(normalized)) return "wecom";
  if (["dingtalk", "openclaw-dingtalk"].includes(normalized)) return "dingtalk";
  if (["feishu", "lark", "larksuite", "openclaw-feishu", "openclaw-lark"].includes(normalized)) return "feishu";
  if (["telegram", "tg", "openclaw-telegram", "openclaw-tg"].includes(normalized)) return "telegram";
  if (["whatsapp", "whats-app", "whatsapp-business", "whatsapp_business", "openclaw-whatsapp"].includes(normalized)) return "whatsapp";
  if (["discord", "openclaw-discord"].includes(normalized)) return "discord";
  if (["slack", "openclaw-slack"].includes(normalized)) return "slack";
  return normalized;
}
