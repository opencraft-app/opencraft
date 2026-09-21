// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * agent-config 统一类型定义（原 types.ts + types.ts + types.ts 合并）
 *
 * 三个分区：
 *   1. 产品差异化配置类型 —— 将 model-providers.ts 中硬编码的产品数据抽为可注入的配置接口
 *   2. Agent 运行时/实例类型 —— 配置数据结构、镜像能力标志、命令执行选项
 *   3. Standard 面板 Props 类型 —— Standard 变体面板组件的 Props
 */

import type { IAgentComponentBaseProps } from './hooks/useAgentInternals';

/** 模型提供商配置 */
export interface IModelProvider {
  /** 唯一标识，用于 Select/Cascader 的 value */
  value: string;
  /** 分类：coding_plan 为 Coding Plan 订阅模式，api 为直接 API 调用模式 */
  category: 'coding_plan' | 'api';
  /** 底层 provider 标识，用于写入 openclaw.json 配置 */
  provider: string;
  /** 显示名称（已国际化） */
  provider_name: string;
  /** 描述信息（可含 HTML） */
  description: string;
  /** API Key 获取地址 */
  api_key_url: string;
  /** API 基础地址 */
  base_url: string;
  /** API 协议类型，如 'openai-completions' | 'anthropic-messages' */
  api: string;
  /** 该提供商支持的模型列表 */
  models: Array<{
    id: string;
    name: string;
    input?: string[];
    isDefault?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>;
  /** OAuth 授权配置（存在则支持 OAuth） */
  oauth?: {
    /** 脚本 init/poll 的 provider 参数（如 'codex'） */
    provider: string;
    /** gateway 生成的 models.json 中的 provider key（如 'openai-codex'），用于 parseConfigResult 匹配 */
    openclawProvider: string;
    /** 是否需要用户回填回调 URL（Authorization Code Flow） */
    requireCallbackUrl?: boolean;
    /** 是否为纯 OAuth 模式（不支持 API Key） */
    exclusive?: boolean;
    /** 写入 openclaw.json 的 provider 配置 */
    providerConfig?: {
      baseUrl: string;
      api: string;
    };
    /** 删除时是否需要清理 auth-profiles.json */
    cleanAuthProfile?: boolean;
    /** init 命令额外参数（如 'cn'），拼接在 provider 之后 */
    initArgs?: string;
    /** poll 命令固定参数（当 requireCallbackUrl=false 时替代回调 URL） */
    pollArgs?: string;
    /** OAuth 专属模型列表（写入 openclaw.json 时使用，不同于 providerInfo.models） */
    models?: Array<{
      id: string;
      name: string;
      input?: string[];
      isDefault?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
}

/** 通道配置 */
export interface IChannelConfig {
  value: string;
  channel: string;
  channel_name: string;
  description?: string;
  url?: string;
  supportQrConfig?: boolean;
  qrCodeOnly?: boolean;
  /** 一级选项展示名；有此字段的通道按数据源顺序作为一级直选项，其余归入「其他」 */
  primaryLabel?: string;
  channel_keys: { key: string; description: string }[];
}

/** getChannelList 函数的配置选项 */
export interface IChannelListOptions {
  /** 是否支持 ADP 通道的 OpenClaw 镜像 */
  isSupportAdpChannelOpenClawBlueprint?: boolean;
  /** 是否支持企微长链接通道的 OpenClaw 镜像 */
  isSupportWecomLongConnOpenClawBlueprint?: boolean;
  /** 是否支持元宝通道的镜像 */
  isSupportYuanbaoChannelBlueprint?: boolean;
  /** 是否支持微信通道的镜像 */
  isSupportWeixinChannelBlueprint?: boolean;
  /** 是否国际站（用于控制国际站专属通道，如 Telegram） */
  isI18n?: boolean;
  /**
   * acli 产品线标识(由 SDK 调用层自动注入,取自 productConfig.acliProduct)。
   * - 'lighthouse'(默认): 轻量应用服务器,实例含公网 IP
   * - 'lightvela': LightVela,实例无公网 IP,默认屏蔽元宝通道(元宝扫码必需 --bind-id + --ip)
   */
  acliProduct?: 'lighthouse' | 'lightvela';
}

/** 镜像版本特性配置 */
export interface IOpenClawVersion {
  /** 镜像 ID */
  id: string;
  /** 该版本支持的功能列表 */
  features: string[];
}

/**
 * 产品差异化配置 —— 由宿主应用注入
 *
 * 将 model-providers.ts 中硬编码的模型列表、通道列表、镜像版本、COS桶域名等
 * 产品相关数据全部抽为可注入配置，使 SDK UI 层零产品硬编码。
 *
 * @example
 * ```tsx
 * const myConfig: IProductConfig = {
 *   modelProviders: [...],
 *   getChannelList: (opts) => [...],
 *   isOpenClawBlueprint: (bp) => bp.BlueprintName?.includes('my-openclaw'),
 * };
 * <OpenClawPanel productConfig={myConfig} {...otherProps} />
 * ```
 */
export interface IProductConfig {
  // ─── 模型配置 ───

  /** 模型提供商列表（原 moltbot.MODEL_PROVIDER_LIST） */
  modelProviders: IModelProvider[];

  /**
   * 根据地域过滤模型提供商列表（原 moltbot.getFilteredModelProviderList）
   * regionId 用于宿主按实例地域决定使用国内/海外模型集合
   * 不传则不过滤，直接使用 modelProviders
   */
  getFilteredModelProviders?: (region?: string, regionId?: number) => IModelProvider[];

  /**
   * 腾讯系 provider 自动获取 API Key
   * 原为 getTencentApiKey 桩函数，现由宿主应用注入完整实现
   * 不传则返回空字符串（即腾讯系 provider 需用户手动输入 Key）
   */
  getTencentApiKey?: (provider: string, modelId?: string) => Promise<string>;

  /**
   * 判断是否为腾讯系 provider（原 moltbot.isTencentProvider）
   * 不传则一律返回 false
   */
  isTencentProvider?: (value: string) => boolean;

  /**
   * 自定义模型 JSON placeholder（原 moltbot.CUSTOM_JSON_PLACEHOLDER）
   * 不传则使用默认值
   */
  customJsonPlaceholder?: string;

  /**
   * 宿主是否支持调用腾讯云 CAPI（`@tencent/iaas-workbench-api-client` 的 apiRequest）
   *
   * - `true`（默认）：展示依赖腾讯云 CAPI 的 provider（混元 / LKEAP / Coding Plan / Token Plan），
   *                 `getTencentApiKey` 可以正常调用 CAPI 自动获取密钥
   * - `false`：自动从 modelProviders 列表中屏蔽 `TENCENT_CLOUD_API_PROVIDERS` 中的 provider
   *
   * 适用场景：
   * - tea-app-lighthouse（腾讯云控制台）→ `true`
   * - mono / 非腾讯云账号体系 → `false`
   */
  supportsTencentCloudApi?: boolean;

  // ─── 通道配置 ───

  /**
   * 获取通道列表（原 moltbot.getChannelListNew）
   * 接收 featureFlags 相关参数，返回当前产品支持的通道列表
   */
  getChannelList: (options: IChannelListOptions) => IChannelConfig[];

  /**
   * 根据通道和镜像版本获取 plugin 名称（原 moltbot.getChannelPluginName）
   * 不传则使用默认映射（CHANNEL_PLUGIN_MAP）
   */
  getChannelPluginName?: (channelValue: string, isSupportQQBotPlugin?: boolean) => string | undefined;

  // ─── 镜像版本 ───

  /**
   * 镜像版本特性映射（原 moltbot.OPENCLAW_VERSIONS）
   * 不传则所有功能默认支持
   */
  openclawVersions?: IOpenClawVersion[];

  /**
   * 根据功能获取不支持的镜像列表（原 moltbot.getNotSupportList）
   * 不传则返回空数组（所有镜像都支持）
   */
  getNotSupportList?: (feature: string) => string[];

  /**
   * 判断是否为 OpenClaw 镜像（原 moltbot.isOpenClaw）
   * 不传则按 BlueprintName 包含 'clawdbot' 判断
   */
  isOpenClawBlueprint?: (blueprint: { BlueprintId?: string; BlueprintName?: string }) => boolean;

  // ─── 扩展命令 ───

  /**
   * 业务扩展方法（原 lighthouse 的 ext）
   * 宿主应用可注入自定义命令生成方法，扩展 SDK scripts 实例
   */
  ext?: Record<string, (...args: any[]) => string>;

  // ─── 国际化 ───

  /**
   * 是否国际站（原 IS_I18N）
   * 不传则默认 false
   */
  isI18n?: boolean;

  // ─── Agent 类型 ───

  /**
   * Agent 类型，区分不同的 AI 助手引擎
   * - 'openclaw'：OpenClaw（默认）
   * - 'hermes'：Hermes
   *
   * 不传则默认 'openclaw'
   *
   * 组件层根据该字段决定：
   *   - 使用哪些 scriptCommands 分支（openclaw 脚本 / harness CLI）
   *   - 使用哪些 parsers 解析命令输出
   *   - 启用哪些 UI 功能（见 features）
   */
  agentType?: 'openclaw' | 'hermes';

  /**
   * acli 产品线标识(install.sh 的 ACLI_PRODUCT 环境变量)
   * - 'lighthouse'（默认）: 轻量应用服务器
   * - 'lightvela': LightVela
   * install.sh 据此区分不同消费方的安装行为(例如不同初始化路径、metrics tag 等)。
   */
  acliProduct?: 'lighthouse' | 'lightvela';

  // ─── 功能特性开关（产品差异） ───

  /**
   * 产品特性标志，驱动组件层 UI 差异
   *
   * ⚠️ 与组件 props 的 `featureFlags: IFeatureFlags` 不同：
   * - 本字段回答"这个产品**要不要做** X"（随 agentType 变化，配置时确定）
   * - `featureFlags` 回答"这台机器**支不支持** X"（随镜像版本变化，运行时计算）
   * 详见 {@link IProductFeatureFlags} JSDoc
   *
   * 每个开关若不传则取 OpenClaw 的默认行为（多数为 true）；
   * Hermes 应显式禁用 oauth / switchDefaultModel / pluginManagement / webUI / clawChatLink / channelGrouping。
   */
  features?: IProductFeatureFlags;

  // ─── CLI 输出解析器（Hermes 用 JSON，OpenClaw 用多行文本/JSON） ───

  /**
   * CLI 输出解析器集合
   *
   * Hermes 镜像必须注入这里的解析函数（因为 `harness xxx` 返回 JSON）。
   * OpenClaw 不需要注入，内置逻辑可直接消费 gateway 配置文件。
   */
  parsers?: IProductParsers;

  // ─── 静态模板（不同镜像展示文案不同） ───

  /**
   * Skills 安装确认弹窗的提示文案（可选）
   * 不传则使用 OpenClaw 默认文案（含 "第三方 ClawHub 社区收录"）。
   * Hermes 可传 "第三方社区收录" 版本。
   */
  skillInstallConfirmText?: string;
}

/**
 * 产品特性标志（Product Form Flags）—— 产品级、配置时确定
 *
 * ⚠️ 与 `IFeatureFlags`（OpenClawPanel 的 `featureFlags` props）区分：
 *
 * | 维度     | IProductFeatureFlags（本类型）           | IFeatureFlags                        |
 * | -------- | ---------------------------------------- | ------------------------------------ |
 * | 数据来源 | 当前 **agent 类型**（openclaw/hermes）   | 当前实例的**镜像版本**（Blueprint）  |
 * | 回答问题 | "这个产品形态需不需要做 X ？"            | "这台机器支不支持 X 能力？"          |
 * | 决定者   | createLighthouseConfig() 根据 agentType  | 宿主根据 Blueprint 版本计算          |
 * | 变化频率 | 每种 agent 类型一套                      | 每台实例不同（随镜像升级）           |
 * | 典型例子 | `oauth`（Hermes 产品不含 OAuth 流程）    | `skills`（V4+ 镜像才支持）           |
 *
 * 设计目标：用这些 flag 替代组件层 `if (agentType === 'hermes')` 硬编码，
 * 让具体行为与 agentType 解耦——未来新增 agent 类型只改配置、不改组件。
 *
 * 典型组合使用：
 * ```ts
 * // ChannelCard 里渲染"企微入口"
 * if (!featureFlags.wecomChannel) return null;          // ← 镜像能力判断
 * if (productConfig.features?.channelGrouping) { ... }  // ← 产品形态判断
 * ```
 */
export interface IProductFeatureFlags {
  /** 是否支持 OAuth 授权（Hermes 为 false） */
  oauth?: boolean;
  /** 是否支持在多 provider 间切换默认模型（Hermes 为 false——只有单 activeModel） */
  switchDefaultModel?: boolean;
  /** 是否启用通道的 plugin 管理（Hermes 为 false） */
  pluginManagement?: boolean;
  /** 是否展示 WebUI 区块（Hermes 当前为 false，后续版本可开启） */
  webUI?: boolean;
  /** 是否展示 ClawChat 链接（Hermes 为 false） */
  clawChatLink?: boolean;
  /**
   * 通道菜单是否按 "一级直选项 + 其他" 分组展示
   * - OpenClaw: true
   * - Hermes: false（固定 3 个通道，简单列表）
   */
  channelGrouping?: boolean;
  /**
   * 命令执行完毕后是否需要整体重启网关才能刷新状态
   * - OpenClaw: true（使用 restartAndRefresh）
   * - Hermes: false（harness 内部已自动重启，前端只需 refresh 列表）
   */
  restartAfterMutation?: boolean;
}

/**
 * CLI 输出解析器
 *
 * Hermes 的 `harness xxx` 输出为 JSON，格式与 OpenClaw 不同；
 * 通过注入 parser 将产品差异从组件层收敛到 productConfig。
 */
export interface IProductParsers {
  /**
   * 解析 provider 列表命令输出（`acli provider list`）
   *
   * Hermes (acli): 返回 { defaultProvider, defaultModel, providers: IAcliProvider[] }
   * OpenClaw: 返回 { providers, activeModel }（兼容旧格式）
   */
  providerList?: (rawOutput: string) => {
    providers: any[];
    activeModel?: any | null;
    defaultProvider?: string;
    defaultModel?: string;
  };

  /**
   * 解析通道状态命令输出（`acli channel status`）
   * 返回规范化的 channel 数组（仅 connected 通道）
   */
  channelList?: (rawOutput: string) => Array<{
    value: string;
    channel: string;
    channel_name: string;
    enabled: boolean;
  }>;

  /**
   * 解析网关状态命令输出（`acli gateway status`）
   * 返回状态字符串（'running' | 'stopped' | 'unknown'）
   */
  gatewayStatus?: (rawOutput: string) => string;
}

/**
 * 防火墙适配器接口
 *
 * WebUIPanel 中「检查端口是否放通」和「放通端口」需要调用宿主应用的防火墙 API，
 * 不同产品线（lighthouse / CVM / ECM 等）的 API 差异较大，
 * 通过适配器模式抽象为统一接口，由宿主应用注入具体实现。
 *
 * @example
 * ```tsx
 * import { createLighthouseFirewallAdapter } from '@tencent/tea-sdk-lightclaw';
 *
 * // lighthouse 使用内置适配器
 * <OpenClawWebUIPanel firewallAdapter={createLighthouseFirewallAdapter()} ... />
 *
 * // 其他产品自定义适配器
 * const myAdapter: IFirewallAdapter = {
 *   checkPort: async (instanceId, regionId, port) => { ... },
 *   openPort: async (instanceId, regionId, port) => { ... },
 * };
 * <OpenClawWebUIPanel firewallAdapter={myAdapter} ... />
 * ```
 */
export interface IFirewallAdapter {
  /**
   * 检查指定端口是否已放通
   * @returns true 表示已放通，false 表示未放通
   */
  checkPort: (instanceId: string, regionId: number, port: number) => Promise<boolean>;

  /**
   * 放通指定端口
   * @returns true 表示放通成功，false 表示失败
   */
  openPort: (instanceId: string, regionId: number, port: number) => Promise<boolean>;
}

// ═══ 2. Agent 运行时/实例类型（原 types.ts）═══

// Config data from remote openclaw.json (OpenClaw) or harness CLI outputs (Hermes)
export interface IConfigData {
  channels: any[];
  providers: any[];
  webUI: { port?: number; basePath?: string; token?: string };
  /**
   * Hermes 专属：当前生效的模型（`harness model list` 的 active_model 字段）
   * OpenClaw 下该字段为 null
   */
  activeModel?: any | null;
}

// Gateway command execution options
export interface IExecuteCommandOptions {
  command: string;
  action: string;
  showButtonLoading?: boolean;
  shouldQueryStatus?: boolean;
  timeout?: number;
  callback?: (result?: any) => void | Promise<void>;
  onFailed?: (error?: any) => void | Promise<void>;
}

/**
 * 镜像能力标志（Blueprint Capability Flags）—— 实例级、运行时动态
 *
 * ⚠️ 与 `IProductFeatureFlags`（`productConfig.features`）区分：
 *
 * | 维度     | IFeatureFlags（本类型）              | IProductFeatureFlags                     |
 * | -------- | ------------------------------------ | ---------------------------------------- |
 * | 数据来源 | 当前实例的**镜像版本**（Blueprint）  | 当前 **agent 类型**（openclaw/hermes）   |
 * | 回答问题 | "这台机器支不支持 X 能力？"          | "这个产品形态需不需要做 X ？"            |
 * | 决定者   | 宿主根据 Blueprint 版本计算          | createLighthouseConfig() 根据 agentType  |
 * | 变化频率 | 每台实例不同（随镜像升级）           | 每种 agent 类型一套                      |
 * | 典型例子 | `channel`（V3+ 才支持）              | `channelGrouping`（产品设计差异）        |
 *
 * 典型组合使用：
 * ```ts
 * // ChannelCard 里渲染"企微入口"
 * if (!featureFlags.wecomChannel) return null;          // ← 镜像能力判断
 * if (productConfig.features?.channelGrouping) { ... }  // ← 产品形态判断
 * ```
 */
export interface IFeatureFlags {
  /** 镜像是否内置 gateway（V3+） */
  gateway: boolean;
  /** 镜像是否支持通道配置（V2+） */
  channel: boolean;
  /** 镜像是否支持企微通道（V5+） */
  wecomChannel: boolean;
  /** 镜像是否支持 ADP 通道（V6+） */
  adpChannel: boolean;
  /** 镜像是否支持企微长链接（V7+） */
  wecomLongConn: boolean;
  /** 镜像是否支持元宝通道（V9+） */
  yuanbaoChannel: boolean;
  /** 镜像是否支持微信通道（V10+） */
  weixinChannel: boolean;
  /** 镜像是否支持扫码配置（V4+） */
  qrConfig: boolean;
  /** 镜像是否支持技能安装（V4+） */
  skills: boolean;
  /** 镜像是否内置 WebUI（V8+） */
  webUI: boolean;
  /** 镜像是否支持记忆管理（V11+） */
  memoryManagement: boolean;
  /** 镜像是否使用 V2 记忆插件（V13+） */
  memoryV2: boolean;
  /** 镜像是否内置 QQ 机器人插件（V12+） */
  qqbotplugin: boolean;
}

// Instance info interface
export interface IInstanceInfo {
  InstanceId: string;
  ProfileId?: string;
  RegionId: number;
  PlatformType?: string;
  Zone?: string;
  [key: string]: any;
}

// ═══ 3. Standard 面板 Props 类型（原 types.ts）═══

// ─── 公共 Props 基类 ───

export interface IStandardPanelBaseProps extends IAgentComponentBaseProps {
  /** 数据是否准备就绪 */
  isDataReady?: boolean;
  /** 操作禁用提示（有值时禁用所有操作） */
  operationDisabledTip?: string;
  /** 自定义 CSS class name */
  className?: string;
}

// ─── ModelPanel ───

export type ModelConfigKind = 'coding_plan' | 'api' | 'custom';
export type CustomApiMode = 'openai-completions' | 'anthropic-messages';
export type CustomInputMode = 'form' | 'json';

export interface ModelPanelProps extends IStandardPanelBaseProps {}

// ─── ChannelPanel ───

export interface ChannelPanelProps extends IStandardPanelBaseProps {}
