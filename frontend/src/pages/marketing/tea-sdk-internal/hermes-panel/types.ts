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
  RegionId: number;
  PlatformType?: string;
  Zone?: string;
  [key: string]: any;
}
