// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * Lighthouse 默认产品配置（mono2 本地专用）
 *
 * 说明：此文件由 `@tencent/tea-sdk-lightclaw` SDK 迁移进 mono2 后精简为「本地专用」。
 * mono2 主入口（agent-settings-page.tsx）只使用 Hermes 形态（走 harness CLI 命令链路），
 * 原 SDK 中的 OpenClaw 形态（走 COS 脚本命令链路）在 mono2 场景下走不到，已移除，
 * 以避免引入用不到的 openclaw-only 依赖与死分支。
 */

import { IS_I18N } from './constants';
import type { IProductConfig, IProductFeatureFlags, IModelProvider } from './types';

// ─── 复用 model-providers.ts 中的数据和函数 ───
import {
  MODEL_PROVIDER_LIST,
  getFilteredModelProviderList,
  isTencentProvider as _isTencentProvider,
  CUSTOM_JSON_PLACEHOLDER,
} from './utils/model-providers';

// ─── Hermes 专属解析函数(产品形态无关，本地实现) ───
import {
  parseHermesChannelList,
  parseHermesGatewayStatus,
  isHermes as _isHermes,
  parseAcliProviderList,
  getHermesChannelList,
} from "./utils/hermes-parsers";

/**
 * Hermes 默认模型提供商列表 —— 从全量列表派生,过滤掉 OAuth-only 的 provider。
 *
 * 注意:LH 的"按地域 + 站点(国内/国际)再做一轮过滤"已下沉至 LH 自有 productConfig,
 * 默认 Hermes 配置只提供基础全集,消费方可通过 productConfig.modelProviders /
 * getFilteredModelProviders 覆盖。
 */
const buildHermesModelProviders = (base: IModelProvider[] = MODEL_PROVIDER_LIST): IModelProvider[] =>
  base.filter((p) => !p.oauth?.exclusive).map(({ oauth: _oauth, ...rest }) => rest);

/** Hermes features —— 精简功能集 */
const HERMES_FEATURES: IProductFeatureFlags = {
  oauth: false,
  switchDefaultModel: false,
  pluginManagement: false,
  webUI: false,
  clawChatLink: false,
  channelGrouping: false,
  // harness 命令内部已处理重启，前端只需 refresh
  restartAfterMutation: false,
};

/** `createLighthouseConfig` 可选参数 */
export interface ICreateLighthouseConfigOptions {
  /**
   * Agent 类型（mono2 本地专用，仅支持 `'hermes'`）
   *
   * 保留该字段是为了与调用点（agent-settings-page.tsx 显式传 `agentType: 'hermes'`）
   * 的调用形态兼容；mono2 场景下始终为 Hermes（走 harness CLI 命令链路）。
   */
  agentType?: IProductConfig['agentType'];

  /**
   * 宿主是否支持调用腾讯云 CAPI（默认 `true`）
   *
   * - `true`：腾讯系 provider 展示"一键添加为默认"，自动通过云 API 获取 Key
   * - `false`：腾讯系 provider 仍然展示，但需要用户手动输入 API Key
   */
  supportsTencentCloudApi?: boolean;

  /**
   * 是否为国际站（默认取 `IS_I18N`，即 tea-app 的 `site === 2`）
   *
   * - 在 tea-app-lighthouse 中无需传入，自动识别
   * - 在 mono2 等外部项目中，需显式传入 `true`/`false` 以正确过滤模型/通道列表
   */
  isI18n?: boolean;

  /**
   * 根据实例地域决定是否使用海外 AI 资产集合（可选）
   *
   * Lighthouse 应注入宿主侧的 `shouldUseOverseaAiAssets(regionId)`，从而保证：
   * - 国际站国内地域使用国内模型集合
   * - 国际站海外地域使用海外模型集合
   *
   * 不传时保持向后兼容，仍按 `isI18n` 站点维度过滤。
   */
  shouldUseOverseaAiAssets?: (regionId?: number, region?: string) => boolean;

  /**
   * 模型提供商列表覆盖（可选）
   *
   * 不传则使用内置的兜底列表 `MODEL_PROVIDER_LIST`。
   * 消费方应通过 `useModelProviders({ isI18n })` 从七彩石拉取后传入，
   * 拉取中/失败时该 hook 会自动回退到兜底列表，因此始终有可用值。
   *
   * 传入后会自动过滤掉 OAuth-only 的 provider（Hermes 不支持 OAuth）。
   */
  modelProviders?: IModelProvider[];
}

/**
 * 创建 Lighthouse 默认产品配置（Hermes 形态）
 *
 * @param options 可选参数（如 supportsTencentCloudApi、isI18n）
 * @returns 完整的 IProductConfig（agentType 恒为 `'hermes'`）
 *
 * @example
 * ```tsx
 * // mono2 主入口
 * <TeaSdkPanel productConfig={createLighthouseConfig({
 *   agentType: 'hermes',
 *   supportsTencentCloudApi: false,
 *   isI18n: isGlobal,
 * })} />
 * ```
 */
export function createLighthouseConfig(options: ICreateLighthouseConfigOptions = {}): IProductConfig {
  const {
    supportsTencentCloudApi: supportsTencentCloudApiOpt,
    isI18n: isI18nOpt,
    shouldUseOverseaAiAssets,
    modelProviders: modelProvidersOpt,
  } = options;
  const supportsTencentCloudApi = supportsTencentCloudApiOpt !== false; // 默认 true
  const isI18n = isI18nOpt ?? IS_I18N; // 外部项目可显式传入，tea-app 自动识别

  // 模型列表：优先用传入的（七彩石拉取结果），否则用内置兜底
  const baseModelProviders = modelProvidersOpt ?? MODEL_PROVIDER_LIST;
  const resolveUseOverseaAiAssets = (regionId?: number, region?: string): boolean =>
    shouldUseOverseaAiAssets ? shouldUseOverseaAiAssets(regionId, region) : isI18n;

  // ─── Hermes 配置 ───
  // 模型/通道列表均派生自全量数据 + 沿用统一过滤策略;
  // 消费方有更细的运营态规则(子集筛选、地域屏蔽等),应通过传入完整的 productConfig 覆盖。
  const hermesModelProviders = buildHermesModelProviders(baseModelProviders);
  return {
    agentType: 'hermes',

    // ─── 模型配置（已过滤 OAuth-only） ───
    modelProviders: hermesModelProviders,
    getFilteredModelProviders: (region?: string, regionId?: number) => {
      // 复用 getFilteredModelProviderList 的过滤逻辑,但只保留 hermes 范围的 provider
      const allowedValues = new Set(hermesModelProviders.map((p) => p.value));
      const useOversea = resolveUseOverseaAiAssets(regionId, region);
      return getFilteredModelProviderList(
        region,
        baseModelProviders,
        useOversea,
        // useOverseaTokenhubUrl 不单独传，默认跟随集合（tokenhub 按机器地域切换，与 mono2 现状一致）
        undefined,
        // 站点维度显式透传（规则 1/2 依赖），避免依赖 moltbot 内部 IS_I18N 与本地 isI18n 恰好相等
        isI18n,
      ).filter((p) => allowedValues.has(p.value));
    },
    isTencentProvider: supportsTencentCloudApi ? _isTencentProvider : () => false,
    customJsonPlaceholder: CUSTOM_JSON_PLACEHOLDER,
    supportsTencentCloudApi,

    // ─── 通道配置 ───
    // Hermes 默认通道列表 = 国内站 6 个(微信/QQ/企微/钉钉/元宝/飞书) + 国际站 8 个
    // (微信/QQ/企微/飞书/Telegram/Discord/Slack/WhatsApp,过滤元宝与钉钉),由 isI18n 自动切换。
    // 业务方在顶层 productConfig 上设置 acliProduct: 'lightvela',会在调用时由
    // useAgentConfig.computeChannelList 透传到 opts.acliProduct,从而屏蔽元宝。
    // 数据源:`scripts/commands/hermes.HERMES_CHANNEL_LIST`(SDK 内置)。
    // 消费方如有定制需求(如 LH 按地域过滤),可在 createLighthouseConfig 后覆盖此字段。
    getChannelList: (opts) =>
      getHermesChannelList({
        isI18n: opts?.isI18n,
        acliProduct: opts?.acliProduct,
      }),
    getChannelPluginName: () => undefined,

    // ─── 镜像识别（Hermes 专属） ───
    isOpenClawBlueprint: _isHermes,
    // Hermes 不使用 openclawVersions / getNotSupportList —— 能力由 features 字段统一管理
    openclawVersions: [],
    getNotSupportList: () => [],

    // ─── 国际化 ───
    isI18n,

    // ─── 功能开关 ───
    features: HERMES_FEATURES,

    // ─── CLI 输出解析器 ───
    parsers: {
      providerList: parseAcliProviderList,
      channelList: parseHermesChannelList,
      gatewayStatus: parseHermesGatewayStatus,
    },

    // ─── Skills 安装提示文案 ───
    skillInstallConfirmText: undefined, // 组件层可读 agentType='hermes' 切换默认文案
  };
}
