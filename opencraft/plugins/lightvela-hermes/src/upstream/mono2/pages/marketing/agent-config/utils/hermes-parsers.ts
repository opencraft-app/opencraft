// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview Hermes(acli) 输出解析与通道数据 —— 本地实现
 *
 * 这些是 acli 命令 stdout 的解析契约与 Hermes 通道字典，原先从
 * `@tencent/tea-sdk-lightclaw` 主入口引入。为让 ChannelPanel/ModelPanel 彻底本地化
 * （仅 scripts 命令生成继续从 SDK `/scripts` 子入口拿），把这批纯函数与数据迁进本地。
 *
 * 全部为无 IO 的纯函数 + 静态数据，i18n 文案走本地 `@/i18n/t`。
 */

import { t } from "../../../../i18n/t";
import type { IChannelConfig, IChannelListOptions } from "../types";

// ===========================================================================
// acli 标准响应解析底座
// ===========================================================================

/**
 * acli 标准响应形如 `{ success, data, error:{code,message} }`。
 * bootstrap 这类输出裸 sentinel（如 __ACLI_OK__）的命令不要走这里，
 * 用 String.includes 自行匹配。
 */
export type AcliResult<T> =
  | { ok: true; data: T }
  | { ok: false; code?: string; message?: string };

export function parseAcli<T>(json: string, extract: (data: unknown) => T): AcliResult<T> {
  if (!json) return { ok: false, code: "EMPTY_OUTPUT" };
  try {
    const raw = JSON.parse(json) as { success?: boolean; data?: unknown; error?: { code?: string; message?: string } };
    if (raw?.success === true) return { ok: true, data: extract(raw?.data) };
    return { ok: false, code: raw?.error?.code, message: raw?.error?.message };
  } catch {
    return { ok: false, code: "PARSE_ERROR" };
  }
}

/** 查询场景便捷版：失败返回 fallback，不暴露 error 细节。 */
export function parseAcliOr<T>(json: string, extract: (data: unknown) => T, fallback: T): T {
  const r = parseAcli(json, extract);
  return r.ok ? r.data : fallback;
}

// ===========================================================================
// 镜像识别
// ===========================================================================

/** 判断镜像是否为 Hermes 镜像（BlueprintName 含 'hermes_agent'）。 */
export const isHermes = (bluePrint?: { BlueprintName?: string }): boolean =>
  bluePrint?.BlueprintName?.includes("hermes_agent") || false;

// ===========================================================================
// 网关状态
// ===========================================================================

export const HERMES_GATEWAY_STATUS = {
  RUNNING: "running",
  STOPPED: "stopped",
  UNKNOWN: "unknown",
} as const;

/** 解析 `acli gateway status`：`{ success, data:{ running:boolean } }`。 */
export function parseHermesGatewayStatus(json: string): string {
  const r = parseAcli(json, (data) => !!(data as { running?: boolean })?.running);
  if (!r.ok) return HERMES_GATEWAY_STATUS.UNKNOWN;
  return r.data ? HERMES_GATEWAY_STATUS.RUNNING : HERMES_GATEWAY_STATUS.STOPPED;
}

// ===========================================================================
// api 字段规范化
// ===========================================================================

/**
 * 预设里的连字符 api 值映射为 acli 期望的下划线形式，其余原样透传。
 * - `openai-completions` → `chat_completions`
 * - `anthropic-messages` → `anthropic_messages`
 */
export function normalizeHermesApi(api: string): string {
  if (api === "openai-completions") return "chat_completions";
  if (api === "anthropic-messages") return "anthropic_messages";
  return api;
}

// ===========================================================================
// provider list 解析
// ===========================================================================

export interface IAcliProvider {
  name: string;
  configured: boolean;
  currentModel: string;
  isDefault: boolean;
  models: Array<{ id: string; name: string }>;
}

export interface IAcliProviderList {
  defaultProvider: string;
  defaultModel: string;
  providers: IAcliProvider[];
}

/** 解析 `acli provider list`。 */
export const parseAcliProviderList = (json: string): IAcliProviderList =>
  parseAcliOr(
    json,
    (raw) => {
      const data = raw as {
        default_provider?: string;
        default_model?: string;
        providers?: Array<{
          name?: string;
          configured?: boolean;
          current_model?: string;
          is_default?: boolean;
          models?: Array<{ id?: string; name?: string }>;
        }>;
      };
      return {
        defaultProvider: data?.default_provider ?? "",
        defaultModel: data?.default_model ?? "",
        providers: (Array.isArray(data?.providers) ? data.providers : [])
          .filter((p) => typeof p?.name === "string")
          .map((p) => ({
            name: p.name as string,
            configured: !!p.configured,
            currentModel: p.current_model ?? "",
            isDefault: !!p.is_default,
            models: (Array.isArray(p.models) ? p.models : [])
              .filter((m) => typeof m?.id === "string")
              .map((m) => ({ id: m.id as string, name: m.name ?? (m.id as string) })),
          })),
      };
    },
    { defaultProvider: "", defaultModel: "", providers: [] },
  );

// ===========================================================================
// channel status 解析
// ===========================================================================

/** 已连接通道（`acli channel status` 解析结果 item）。 */
export interface IConnectedChannel {
  value: string;
  channel: string;
  channel_name: string;
  enabled: boolean;
}

/**
 * 解析 `acli channel status`，仅保留 status:'connected' 的通道。
 * acli 返回 `data.platforms[].status === 'connected' | 'disconnected'`，
 * `name` 字段对应通道 key（weixin / qqbot / wecom / yuanbao / feishu）。
 * channel_name 用 acli 返回的 name 兜底，中文名由消费方 parsers 覆盖。
 */
export const parseHermesChannelList = (json: string): IConnectedChannel[] =>
  parseAcliOr(
    json,
    (raw) => {
      const data = raw as { platforms?: Array<{ status?: string; name?: string }> };
      const platforms = Array.isArray(data?.platforms) ? data.platforms : [];
      return platforms
        .filter((p) => p?.status === "connected" && typeof p?.name === "string")
        .map((p) => ({
          value: p.name as string,
          channel: p.name as string,
          channel_name: p.name as string,
          enabled: true,
        }));
    },
    [] as IConnectedChannel[],
  );

// ===========================================================================
// model probe 解析
// ===========================================================================

export interface IHermesModelProbeParams {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: string;
}

/** 单条模型连通性结果。 */
export interface IHermesModelProbeItem {
  api?: string;
  base_url?: string;
  error_code?: number;
  error_message?: string;
  model?: string;
  success?: boolean;
  time_ms?: number;
  [key: string]: unknown;
}

/** `acli model probe` 标准响应内的连通性 payload。 */
export interface IHermesModelProbeResult {
  agent?: string;
  api?: string;
  base_url?: string;
  configured?: boolean;
  error_code?: number;
  error_message?: string;
  message?: string;
  model?: string;
  provider?: string;
  results?: IHermesModelProbeItem[];
  success?: boolean;
  time_ms?: number;
  [key: string]: unknown;
}

/** 解析 `acli model probe` 的嵌套 payload。 */
export const parseHermesModelProbe = (json: string): AcliResult<IHermesModelProbeResult> =>
  parseAcli(json, (data) => ({
    ...(data && typeof data === "object" ? (data as IHermesModelProbeResult) : {}),
    results: Array.isArray((data as IHermesModelProbeResult)?.results)
      ? (data as IHermesModelProbeResult).results
      : [],
  }));

/** probe payload 是否包含至少一条成功的连通性结果。 */
export const isHermesModelProbeSuccessful = (result: IHermesModelProbeResult): boolean =>
  result.success === true &&
  (result.error_code ?? 0) === 0 &&
  (result.results?.some((item) => item.success === true) ?? false);

// ===========================================================================
// 扫码流式输出解析
// ===========================================================================

export interface IHermesQrStreamResult {
  platform?: string;
  status?: "pending" | "scanned" | "success" | "failed";
  url?: string;
  error_code?: string;
  [key: string]: unknown;
}

/**
 * 解析 `gateway qr-url --wait true` 的 NDJSON 流式输出，取最后一个有效状态行。
 * 失败行归一化为 status:'failed'：
 *  - 有 error_code 且无 status
 *  - status === 'error'（如 QR_CONFIG_FAILED）
 */
export function parseHermesQrStream(stdout: string): IHermesQrStreamResult | null {
  if (!stdout) return null;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as IHermesQrStreamResult;
      if (!obj?.platform) continue;
      if (typeof obj.error_code === "string" && !obj.status) {
        return { ...obj, status: "failed" };
      }
      if ((obj.status as string) === "error") {
        return { ...obj, status: "failed" };
      }
      if (obj.status === "pending" || obj.status === "scanned" || obj.status === "success" || obj.status === "failed") {
        return obj;
      }
    } catch {
      // 非 JSON 行，跳过
    }
  }
  return null;
}

// ===========================================================================
// Hermes 通道字典
// ===========================================================================

/** 内部通道 item 结构：比 IChannelConfig 多 i18nOnly/domesticOnly（仅用于站点级过滤，不对外暴露）。 */
type IHermesChannelItem = IChannelConfig & {
  /** 仅国际站(海外集合)展示（Telegram/Discord/Slack/WhatsApp） */
  i18nOnly?: boolean;
  /** 仅国内站(国内集合)展示（钉钉） */
  domesticOnly?: boolean;
};

// 同 model-providers.ts：t() 走 @/i18n/t（i18n 顶层同步 init 且经 import 链先于本模块求值），
// 顶层直接求值即安全，无需惰性缓存。
const HERMES_CHANNEL_LIST: IHermesChannelItem[] = [
    {
      value: "weixin",
      channel: "weixin",
      channel_name: t("微信"),
      primaryLabel: t("微信"),
      description: t("微信是一款跨平台的通讯工具。"),
      url: "https://weixin.qq.com",
      supportQrConfig: true,
      qrCodeOnly: true,
      channel_keys: [],
    },
    {
      value: "qqbot",
      channel: "qqbot",
      channel_name: t("QQ"),
      primaryLabel: t("QQ"),
      description: t("一键解锁智能玩法，开启你的个性化QQ机器人之旅。"),
      url: "https://q.qq.com/qqbot/openclaw/",
      supportQrConfig: true,
      channel_keys: [
        { key: "appId", description: t("QQ机器人的App ID") },
        { key: "clientSecret", description: t("QQ机器人的App Secret") },
      ],
    },
    {
      value: "wecom",
      channel: "wecom",
      channel_name: t("企业微信"),
      primaryLabel: t("企业微信"),
      description: t("企业微信是一款高效协同办公的企业通讯与办公工具。"),
      url: "https://work.weixin.qq.com/wework_admin/frame#/aiHelper/create",
      supportQrConfig: true,
      channel_keys: [
        { key: "botId", description: t("企业微信机器人的botId") },
        { key: "secret", description: t("企业微信机器人的secret") },
      ],
    },
    {
      value: "dingtalk",
      channel: "dingtalk",
      channel_name: t("钉钉"),
      primaryLabel: t("钉钉"),
      description: t("钉钉是阿里巴巴公司打造的智能办公平台，驱动组织数字化管理升级。"),
      url: "https://open.dingtalk.com/",
      domesticOnly: true,
      channel_keys: [
        { key: "clientId", description: t("钉钉应用的 Client ID") },
        { key: "clientSecret", description: t("钉钉应用的 Client Secret") },
      ],
    },
    {
      value: "yuanbao",
      channel: "yuanbao",
      channel_name: t("元宝"),
      primaryLabel: t("元宝"),
      description: t("元宝是腾讯推出的 AI 助手。"),
      url: "https://yuanbao.tencent.com/",
      supportQrConfig: true,
      channel_keys: [
        { key: "appKey", description: t("元宝 Bot 的 App ID") },
        { key: "appSecret", description: t("元宝 Bot 的 App Secret") },
      ],
    },
    {
      value: "feishu",
      channel: "feishu",
      channel_name: t("飞书"),
      primaryLabel: t("飞书"),
      description: t("飞书是字节跳动推出的一站式先进协作平台，AI 赋能助力高效办公。"),
      url: "https://open.feishu.cn/",
      supportQrConfig: true,
      qrCodeOnly: true,
      channel_keys: [],
    },
    {
      value: "telegram",
      channel: "telegram",
      channel_name: "Telegram",
      primaryLabel: "Telegram",
      description: t("Telegram 是一款注重速度与安全的即时通讯工具。"),
      url: "https://core.telegram.org/bots",
      i18nOnly: true,
      channel_keys: [{ key: "botToken", description: t("Telegram Bot Token") }],
    },
    {
      value: "discord",
      channel: "discord",
      channel_name: "Discord",
      primaryLabel: "Discord",
      description: t("Discord 是面向社区的语音、视频和文字通讯平台。"),
      url: "https://discord.com/developers/applications",
      i18nOnly: true,
      channel_keys: [{ key: "botToken", description: t("Discord Bot Token") }],
    },
    {
      value: "slack",
      channel: "slack",
      channel_name: "Slack",
      primaryLabel: "Slack",
      description: t("Slack 是一个高效的团队协作平台，简化工作场所沟通。"),
      url: "https://api.slack.com/apps",
      i18nOnly: true,
      channel_keys: [
        { key: "botToken", description: t("Slack Bot Token") },
        { key: "appToken", description: t("Slack App Token") },
      ],
    },
    {
      value: "whatsapp",
      channel: "whatsapp",
      channel_name: "WhatsApp",
      primaryLabel: "WhatsApp",
      description: t("WhatsApp 是全球领先的即时通讯应用。"),
      url: "https://business.whatsapp.com/",
      i18nOnly: true,
      supportQrConfig: true,
      qrCodeOnly: true,
      channel_keys: [],
    },
  ];

const HERMES_I18N_CHANNEL_ORDER = ["telegram", "discord", "slack", "whatsapp", "weixin", "qqbot", "wecom", "feishu"];

function sortHermesI18nChannelList(list: IHermesChannelItem[]): IHermesChannelItem[] {
  return list.sort(
    (a, b) => HERMES_I18N_CHANNEL_ORDER.indexOf(a.value) - HERMES_I18N_CHANNEL_ORDER.indexOf(b.value),
  );
}

/**
 * 按站点过滤 Hermes 通道列表。
 * - 国内集合（默认）：屏蔽 i18nOnly 通道（Telegram/Discord/Slack/WhatsApp），保留元宝与 domesticOnly 通道（钉钉）
 * - 海外集合（isI18n）：屏蔽元宝（国内独有）与 domesticOnly 通道（钉钉），展示 i18nOnly 通道
 * - lightvela 产品：屏蔽元宝（实例无公网 IP，元宝扫码必需 --bind-id + --ip，无法满足）
 */
export function getHermesChannelList(
  options: Pick<IChannelListOptions, "isI18n" | "acliProduct"> = {},
): IChannelConfig[] {
  const useOversea = !!options.isI18n;
  const isLightvela = options.acliProduct === "lightvela";
  const list = HERMES_CHANNEL_LIST.filter((ch) => {
    if (ch.value === "yuanbao" && (useOversea || isLightvela)) return false;
    if (!useOversea && ch.i18nOnly) return false;
    // 钉钉等国内独有通道：海外集合屏蔽
    if (useOversea && ch.domesticOnly) return false;
    return true;
  });
  const filtered = useOversea ? sortHermesI18nChannelList(list) : list;
  // 剥离内部 i18nOnly / domesticOnly 字段，对外只暴露 IChannelConfig。
  return filtered.map(({ i18nOnly: _i18nOnly, domesticOnly: _domesticOnly, ...rest }) => rest);
}
