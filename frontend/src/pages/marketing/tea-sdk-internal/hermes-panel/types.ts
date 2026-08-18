import type { LightClawScriptsSDK } from "@tencent/tea-sdk-lightclaw/scripts";
import type { ICommandExecutor } from '../local-command-executor';
import type { IProductConfig, IFirewallAdapter } from '../config/types';

// Step status type (from OpenClawConfig)
export type StepStatus = 'success' | 'loading' | 'error' | 'warning';

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

// Confirm modal config
export interface IConfirmModalConfig {
  type: 'model_switch' | 'channel_add' | 'delete';
  payload?: any;
  onConfirm: () => void;
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
  RegionId: number;
  PlatformType?: string;
  Zone?: string;
  [key: string]: any;
}

// OpenClawPanel props
export interface IOpenClawPanelProps {
  /** 实例信息 */
  instance: IInstanceInfo;
  /**
   * 镜像能力标志（基于当前实例 Blueprint 版本计算）
   *
   * ⚠️ 与 `productConfig.features`（产品特性标志）不同：
   * - 本字段回答"这台机器**支不支持** X 能力"（随镜像版本变化）
   * - `productConfig.features` 回答"这个产品**要不要做** X"（随 agent 类型变化）
   * 详见 {@link IFeatureFlags} JSDoc
   */
  featureFlags: IFeatureFlags;
  /** 是否正在升级 */
  isUpgrading: boolean;
  /** 数据是否准备就绪 */
  isDataReady: boolean;
  /** 操作禁用提示 */
  operationDisabledTip: string;
  /** WebUI 弹窗可见性 */
  webUIModalVisible: boolean;
  /** 设置 WebUI 弹窗可见性 */
  setWebUIModalVisible: React.Dispatch<React.SetStateAction<boolean>>;
  /** 展示的镜像版本 */
  displayBlueprintVersion: string;
  /** 自定义样式类名 */
  className?: string;
  /**
   * 可选：外部注入的 scriptCommands 实例
   * 不传则 SDK 内部使用默认配置自动创建（gz 地域 + 默认 COS bucket）
   * 适用于需要扩展命令（ext）的产品定制场景
   */
  scriptCommands?: LightClawScriptsSDK;
  /**
   * 产品差异化配置 —— 由宿主应用注入
   * 包含模型列表、通道列表、镜像版本、COS桶域名等差异化数据
   * 不传则使用 lighthouse 默认配置（createLighthouseConfig()）
   */
  productConfig?: IProductConfig;
  /**
   * 防火墙适配器 — 用于 WebUI 面板检查/放通端口
   * 由宿主应用提供具体实现，不传则 WebUI 面板不渲染
   */
  firewallAdapter?: IFirewallAdapter;
}

// Context value type
export interface IOpenClawContextValue {
  // Instance info
  instance: IInstanceInfo;

  // SDK 实例
  scriptCommands: LightClawScriptsSDK;
  executor: ICommandExecutor;

  // Feature support flags（统一在 index.tsx 计算，子组件直接取用）
  featureFlags: IFeatureFlags;

  // Operation state
  isUpgrading: boolean;
  isOperationDisabled: boolean;
  operationDisabledContent: string;
  operationDisabledTip: string;

  // Shared config data
  configData: IConfigData;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;

  // Shared methods
  currentAction: string;
  setCurrentAction: React.Dispatch<React.SetStateAction<string>>;
  executeGatewayCommand: (options: IExecuteCommandOptions) => Promise<void>;
  restartGateway: (showLoading?: boolean) => Promise<void>;
  restartAndRefresh: (needRestart?: boolean) => Promise<void>;
  getOpenclawConfig: (silent?: boolean) => Promise<IConfigData | void>;

  // Channel and model lists
  currentChannelList: any[];

  // Platform info
  commandType: 'SHELL' | 'POWERSHELL';

  // Confirm modal
  openConfirmModal: (config: IConfirmModalConfig) => void;

  // Product config (injected by host app)
  productConfig: IProductConfig;
}
