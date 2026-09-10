// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview useAgentConfig — 独立的 configData 请求 hook
 *
 * 封装 configData 的请求（getAgentConfig）和解析（parseConfigResult）逻辑，
 * 可独立使用，无需外部 Context。
 *
 * **Hermes 兼容**：当 `productConfig.agentType === 'hermes'` 时，
 * hook 内部自动切换为 acli 数据通路（provider list / channel status），
 * 对外保持相同的返回接口；组件层无需感知 agentType 差异。
 *
 * @example
 * ```tsx
 * import { useAgentConfig } from '@tencent/tea-sdk-lightclaw';
 *
 * function ModelCard(props) {
 *   const { configData, loading, refresh, restartAndRefresh } = useAgentConfig({
 *     instance: props.instance,

 *     featureFlags: props.featureFlags,
 *     productConfig: props.productConfig,
 *   });
 *
 *   // 使用 configData.providers
 *   // 操作后调 refresh() / restartAndRefresh() 刷新
 * }
 * ```
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from "../../../../i18n/t";
import { CHANNEL_LIST } from '../utils/model-providers';
import type { IProductConfig } from '../types';
import type { IConfigData, IFeatureFlags } from '../types';
import { useAgentInternals } from './useAgentInternals';
import type { IAgentComponentBaseProps } from './useAgentInternals';

// ─── 入参类型 ───

export interface IUseAgentConfigParams extends IAgentComponentBaseProps {
  /** 数据是否准备就绪（可选，默认 true） */
  isDataReady?: boolean;
  /** 操作禁用提示（有值时跳过请求） */
  operationDisabledTip?: string;
}

// ─── 返回值类型 ───

export interface IUseAgentConfigResult {
  /** 解析后的配置数据 */
  configData: IConfigData;
  /** 是否正在加载 */
  loading: boolean;
  /** 设置 loading 状态（供外部控制） */
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * 主动刷新配置数据
   * @param silent - 静默模式，不显示 loading
   * @returns 解析后的配置数据，失败时返回 void
   */
  refresh: (silent?: boolean) => Promise<IConfigData | void>;
  /** 重启网关并刷新配置 */
  restartAndRefresh: (needRestart?: boolean) => Promise<void>;
  /** 当前正在执行的操作标识 */
  currentAction: string;
  /** 设置当前操作标识 */
  setCurrentAction: React.Dispatch<React.SetStateAction<string>>;
  /** 当前通道列表（基于 configData.webUI.port + featureFlags + productConfig 计算） */
  currentChannelList: any[];
}

// ─── 常量 ───

const EMPTY_CONFIG: IConfigData = {
  channels: [],
  providers: [],
  webUI: {},
};

// ─── 解析逻辑 ───

/**
 * 解析远端 openclaw.json 配置为 IConfigData
 *
 * 纯函数，不依赖任何 React 状态。
 */
export function parseConfigResult(
  configResult: string,
  options: {
    featureFlags: IFeatureFlags;
    currentChannelList: Array<{ value: string; channel: string; channel_name: string; [key: string]: any }>;
    productConfig: IProductConfig;
  },
): IConfigData {
  const { featureFlags, currentChannelList, productConfig } = options;

  try {
    if (!configResult) return { channels: [], providers: [], webUI: {} };

    const config = JSON.parse(configResult);
    const { gateway } = config;
    const webUI = gateway
      ? {
          port: gateway.port,
          basePath: gateway.controlUi?.basePath,
          token: String(gateway.auth?.token),
        }
      : {};

    // ─── 解析 channels ───
    const channels = Object.entries(config.channels || {})
      .flatMap(([key, channel]: [string, any]) => {
        if (!channel) return [];

        if (key === 'wecom' && featureFlags.wecomChannel) {
          const results: any[] = [];
          if (channel?.bot) {
            const isLongConn = channel.bot.connectionMode === 'websocket';
            const botValue = isLongConn ? 'wecom-bot-long' : 'wecom-bot';
            const botChannelInfo = currentChannelList.find((item) => item.value === botValue);
            results.push({
              value: botValue,
              channel: botChannelInfo?.channel,
              channel_name: botChannelInfo?.channel_name || botValue,
              enabled: channel?.enabled,
              ...channel.bot,
            });
          }
          if (channel?.agent) {
            const agentChannelInfo = currentChannelList.find((item) => item.value === 'wecom-agent');
            results.push({
              value: 'wecom-agent',
              channel: agentChannelInfo?.channel,
              channel_name: agentChannelInfo?.channel_name || 'wecom-agent',
              enabled: channel?.enabled,
              ...channel.agent,
            });
          }
          return results;
        }

        const channelInfo = currentChannelList.find((item) => item.value === key || item.channel === key);
        return [
          {
            value: key,
            channel: channelInfo?.channel || key,
            channel_name: channelInfo?.channel_name || key,
            ...channel,
          },
        ];
      })
      .filter((channel) => {
        if (!currentChannelList.some((item) => item.value === channel.value || item.channel === channel.channel)) {
          return false;
        }
        if (channel.channel === 'feishu' && !channel.appId && !channel.appSecret) {
          return false;
        }
        return true;
      });

    // ─── 解析 providers ───
    const providersSource = config.models?.providers || {};
    const providers = Object.entries(providersSource).flatMap(([key, provider]: [string, any]) => {
      if (!provider) return [];

      const sameNameProviders = productConfig.modelProviders.filter(
        (p) => p.provider === key || p.oauth?.openclawProvider === key,
      );
      let matchedProvider;
      if (sameNameProviders.length === 1) {
        [matchedProvider] = sameNameProviders;
      } else if (sameNameProviders.length > 1) {
        const sameUrlProviders = sameNameProviders.filter((p) => p.base_url === provider?.baseUrl);
        if (sameUrlProviders.length >= 1) {
          if (key === 'minimax' && sameUrlProviders.length > 1) {
            const isCodePlan = typeof provider?.apiKey === 'string' && provider.apiKey.startsWith('sk-cp');
            const [defaultProvider] = sameUrlProviders;
            // 用稳定的 value 字段区分（不随语言变化），避免依赖会国际化的 provider_name
            matchedProvider =
              sameUrlProviders.find((p) =>
                isCodePlan ? p.value === 'minimax_coding' : p.value === 'minimax_domestic',
              ) || defaultProvider;
          } else {
            [matchedProvider] = sameUrlProviders;
          }
        }
      }

      const primaryModel = String(config.agents?.defaults?.model?.primary || '');

      return {
        value: matchedProvider?.value || key,
        provider: key,
        provider_name: matchedProvider?.provider_name || key,
        apiKey: provider?.apiKey || '',
        base_url: provider?.baseUrl || '',
        api: provider?.api || '',
        currentModelId: primaryModel?.startsWith(key) ? primaryModel : '',
        models: (provider?.models || []).map((model: any) => {
          const currentModelPath = `${key}/${model.id}`;
          return {
            ...model,
            enabled: primaryModel === currentModelPath,
          };
        }),
      };
    });

    return { channels, providers, webUI };
  } catch (error) {
    console.error('[useAgentConfig] parseConfigResult failed:', error);
    return { channels: [], providers: [], webUI: {} };
  }
}

// ─── 内部工具函数：计算 currentChannelList ───

function computeChannelList(featureFlags: IFeatureFlags, productConfig: IProductConfig, webUIPort?: number): any[] {
  // Hermes：直接返回固定通道列表（通过 isI18n / acliProduct 控制国际站与产品差异）
  if (productConfig.agentType === 'hermes') {
    return productConfig.getChannelList({
      isI18n: productConfig.isI18n,
      acliProduct: productConfig.acliProduct,
    });
  }

  const shouldFilterLine = webUIPort === 18789 || webUIPort === undefined;

  if (!featureFlags.wecomChannel) {
    return shouldFilterLine ? CHANNEL_LIST.filter((c) => c.value !== 'line') : CHANNEL_LIST;
  }

  const channelList = productConfig.getChannelList({
    isSupportAdpChannelOpenClawBlueprint: featureFlags.adpChannel,
    isSupportWecomLongConnOpenClawBlueprint: featureFlags.wecomLongConn,
    isSupportYuanbaoChannelBlueprint: featureFlags.yuanbaoChannel,
    isSupportWeixinChannelBlueprint: featureFlags.weixinChannel,
  });

  return shouldFilterLine ? channelList.filter((c) => c.value !== 'line') : channelList;
}

// ─── Hook 实现 ───

/**
 * 独立的 configData 请求 hook
 *
 * 将 configData 的请求（getAgentConfig）和解析（parseConfigResult）逻辑
 * 封装为可独立使用的 hook。
 *
 * 内部自动创建 scriptCommands / executor / useGatewayCommand，
 * 消费方只需传最小参数集。
 */
export function useAgentConfig(params: IUseAgentConfigParams): IUseAgentConfigResult {
  const { featureFlags, isDataReady = true, operationDisabledTip = '' } = params;

  // 内部自动创建 scriptCommands / executor / useGatewayCommand
  const {
    scriptCommands,
    scriptsReady,
    executor,
    productConfig,
    executeGatewayCommand,
    currentAction,
    setCurrentAction,
    restartGateway,
  } = useAgentInternals(params);

  const { instance } = params;
  const isHermes = productConfig.agentType === 'hermes';

  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<IConfigData>(EMPTY_CONFIG);

  // 记录已完成 acli bootstrap 的 instanceId，避免 StrictMode 双挂载下重复 bootstrap
  const bootstrappedInstanceRef = useRef<string | null>(null);

  // 计算 currentChannelList（依赖 configData.webUI.port）
  const currentChannelList = useMemo(
    () => computeChannelList(featureFlags, productConfig, configData.webUI?.port),
    [featureFlags, productConfig, configData.webUI?.port],
  );

  // operationDisabledTip 有值时关闭 loading
  useEffect(() => {
    if (operationDisabledTip) {
      setLoading(false);
    }
  }, [operationDisabledTip]);

  // ─── Hermes 数据通路：并行请求 `acli provider list` 和 `acli channel status` ───
  const fetchHermesConfig = async (silent: boolean): Promise<IConfigData | void> => {
    try {
      const modelCmd = scriptCommands.hermes.model.getListCommand();
      const channelCmd = scriptCommands.hermes.channel.getListCommand();

      const [modelRes, channelRes] = await Promise.all([
        executor.run({ command: modelCmd }),
        executor.run({ command: channelCmd }),
      ]);

      const providerListParser = productConfig.parsers?.providerList;
      const channelListParser = productConfig.parsers?.channelList;

      const parsedProviders = providerListParser
        ? providerListParser(modelRes.output)
        : { providers: [] as any[], activeModel: null };
      const channels = channelListParser ? channelListParser(channelRes.output) : ([] as any[]);

      const next: IConfigData = {
        channels,
        providers: parsedProviders.providers,
        webUI: {},
        activeModel: parsedProviders.activeModel ?? null,
      };
      setConfigData(next);
      return next;
    } catch (error) {
      console.error('[useAgentConfig] fetchHermesConfig failed:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // ─── 请求配置数据 ───
  const getAgentConfig = async (silent = false): Promise<IConfigData | void> => {
    if (!isHermes && !featureFlags.gateway) return;

    if (!silent) {
      setLoading(true);
    }

    // Hermes：直接走 harness CLI 数据通路
    if (isHermes) {
      return fetchHermesConfig(silent);
    }

    let resolvedConfig: IConfigData | void = undefined;

    // 请求时重新计算 channelList（因为 webUI.port 可能已更新）
    const latestChannelList = computeChannelList(featureFlags, productConfig, configData.webUI?.port);

    await executeGatewayCommand({
      command: scriptCommands.openclaw.config.GET_OPENCLAW_CONFIG_COMMAND,
      action: 'get_config',
      showButtonLoading: true,
      shouldQueryStatus: false,
      callback: async (result) => {
        try {
          const parsedConfig = parseConfigResult(result, {
            featureFlags,
            currentChannelList: latestChannelList,
            productConfig,
          });

          // 微信通道特殊处理：获取微信账号列表
          if (featureFlags.weixinChannel) {
            try {
              parsedConfig.channels = parsedConfig.channels.filter(
                (ch) => ch.value !== 'openclaw-weixin' && ch.channel !== 'openclaw-weixin',
              );

              let weixinAccounts: string[] = [];
              await executeGatewayCommand({
                command: scriptCommands.openclaw.channel.GET_WEIXIN_ACCOUNTS_COMMAND,
                action: 'get_weixin_accounts',
                showButtonLoading: false,
                shouldQueryStatus: false,
                callback: (accountsResult) => {
                  try {
                    const parsed = JSON.parse(accountsResult);
                    if (Array.isArray(parsed)) weixinAccounts = parsed;
                  } catch {
                    // ignore
                  }
                },
              });
              if (weixinAccounts.length > 0) {
                const weixinChannelInfo = latestChannelList.find((item) => item.value === 'openclaw-weixin');
                parsedConfig.channels.push({
                  value: 'openclaw-weixin',
                  channel: weixinChannelInfo?.channel || 'openclaw-weixin',
                  channel_name: weixinChannelInfo?.channel_name || t('微信'),
                  enabled: true,
                  accountCount: weixinAccounts.length,
                });
              }
            } catch {
              // 检测失败不影响主流程
            }
          }

          setConfigData(parsedConfig);
          resolvedConfig = parsedConfig;
        } finally {
          if (!silent) {
            setLoading(false);
          }
        }
      },
      onFailed: () => {
        if (!silent) {
          setLoading(false);
        }
      },
    });

    return resolvedConfig;
  };

  // ─── 重启网关并刷新 ───
  const restartAndRefresh = async (needRestart = true) => {
    setLoading(true);
    try {
      // Hermes: acli 内部会自动重启网关（features.restartAfterMutation = false），前端只刷新即可
      const shouldRestart =
        productConfig.features?.restartAfterMutation !== false && needRestart && !isHermes && featureFlags.gateway;
      if (shouldRestart) {
        await restartGateway(false);
      }
      await getAgentConfig();
    } catch (error) {
      setLoading(false);
      throw error;
    }
  };

  // ─── mount 时自动请求 ───
  useEffect(() => {
    const instanceId = instance?.InstanceId;
    if (!instanceId || !isDataReady || operationDisabledTip) return;
    // 外部注入的命令集未就绪时不发起自动请求；本地命令生成器始终同步就绪。
    if (!scriptsReady) return;

    // cancelled 旗标：StrictMode 下第一次挂载会立即被卸载，
    // 卸载后禁止继续 setLoading / setConfigData，避免打断第二次挂载已完成的渲染
    let cancelled = false;

    (async () => {
      try {
        // Hermes：先确保 acli 已安装（Bootstrap：self-update 优先 + install.sh 兜底）
        // 安装失败静默继续，后续命令会报错。
        // 按 instanceId 去重：同一实例只 bootstrap 一次，避免两条 ~7s 的 acli 链并行互相打断
        if (isHermes && bootstrappedInstanceRef.current !== instanceId) {
          bootstrappedInstanceRef.current = instanceId;
          const installCmd = scriptCommands.hermes.gateway.getBootstrapCommand(productConfig.acliProduct);
          await executeGatewayCommand({
            command: installCmd,
            action: 'install_acli',
            showButtonLoading: false,
            shouldQueryStatus: false,
            callback: () => {},
          });
        }
        if (cancelled) return;
        await getAgentConfig();
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.InstanceId, isDataReady, operationDisabledTip, scriptsReady]);

  return {
    configData,
    loading,
    setLoading,
    refresh: getAgentConfig,
    restartAndRefresh,
    currentAction,
    setCurrentAction,
    currentChannelList,
  };
}
