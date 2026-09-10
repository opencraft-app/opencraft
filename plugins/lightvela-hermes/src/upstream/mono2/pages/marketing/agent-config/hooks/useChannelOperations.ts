// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview useChannelOperations — 通道操作公共 hook
 *
 * 从 ChannelCard 中抽取的操作逻辑，供 Standard 面板使用。
 * 封装：连接通道（手动配置）、删除通道、扫码触发。
 *
 * mono2 仅承载单一 Hermes 业务，命令路径固定走 Hermes（acli）通路。
 */

import { useCallback, useState } from 'react';
import { useAgentConfig } from './useAgentConfig';
import { useAgentInternals } from './useAgentInternals';
import type { IAgentComponentBaseProps } from './useAgentInternals';
import type { IConfigData } from '../types';
import type { IChannelConfig, IProductConfig } from '../types';

// ─── 类型定义 ───

export interface IUseChannelOperationsParams extends IAgentComponentBaseProps {
  isDataReady?: boolean;
  operationDisabledTip?: string;
}

export interface IConfigureChannelParams {
  /** 通道 value 标识（如 'qqbot'） */
  channelValue: string;
  /** channel key 的值（如 App ID） */
  channelIdValue: string;
  /** channel secret 的值（如 App Secret） */
  channelKeyValue?: string;
  /** 额外参数（如 LINE userId） */
  channelExtra?: string;
}

export interface IUseChannelOperationsResult {
  // ─── 数据 ───
  configData: IConfigData;
  loading: boolean;
  /** 当前通道列表（基于 featureFlags + productConfig 计算） */
  currentChannelList: IChannelConfig[];

  // ─── 操作 ───
  /** 手动配置通道（表单提交） */
  configureChannel: (params: IConfigureChannelParams) => Promise<boolean>;
  /** 删除通道 */
  deleteChannel: (channelValue: string) => Promise<boolean>;
  /** 刷新配置 */
  refresh: () => Promise<void>;

  // ─── 状态 ───
  currentAction: string;
  /** 正在配置中 */
  configuring: boolean;
  /** 正在删除的通道 value */
  deletingChannel: string | null;

  // ─── SDK 能力（供扫码弹窗使用） ───
  scriptCommands: any;
  executor: any;
  instance: any;
  /** 已解析的产品配置（含 isI18n 等，供 UI 层透传给子组件） */
  productConfig: IProductConfig;
}

// ─── Hook 实现 ───

export function useChannelOperations(params: IUseChannelOperationsParams): IUseChannelOperationsResult {
  const { configData, loading, restartAndRefresh, currentAction, setCurrentAction, refresh, currentChannelList } =
    useAgentConfig({
      instance: params.instance,
      scriptCommands: params.scriptCommands,
      featureFlags: params.featureFlags,
      productConfig: params.productConfig,
      commandExecutor: params.commandExecutor,
      isDataReady: params.isDataReady,
      operationDisabledTip: params.operationDisabledTip,
    });

  const { scriptCommands, executor, productConfig } = useAgentInternals({
    instance: params.instance,
    scriptCommands: params.scriptCommands,
    featureFlags: params.featureFlags,
    productConfig: params.productConfig,
    commandExecutor: params.commandExecutor,
  });

  const [configuring, setConfiguring] = useState(false);
  const [deletingChannel, setDeletingChannel] = useState<string | null>(null);

  // 命令引用（Hermes / acli）
  const hermesChannelCmds = scriptCommands.hermes.channel;

  // ── 操作：手动配置通道 ──
  const configureChannel = useCallback(
    async (channelParams: IConfigureChannelParams): Promise<boolean> => {
      const { channelValue, channelIdValue, channelKeyValue } = channelParams;
      const channelInfo = currentChannelList.find((c) => c.value === channelValue);
      if (!channelInfo) return false;

      setConfiguring(true);
      setCurrentAction('configure_channel');

      try {
        // 根据通道获取 Hermes 配置命令
        let channelConfigCommand = '';
        const ch = channelInfo.channel;
        if (ch === 'qqbot') {
          channelConfigCommand = hermesChannelCmds.getQQBotConfigCommand({
            appId: channelIdValue,
            clientSecret: channelKeyValue || '',
          });
        } else if (ch === 'wecom') {
          channelConfigCommand = hermesChannelCmds.getWecomConfigCommand({
            appId: channelIdValue,
            clientSecret: channelKeyValue || '',
          });
        } else if (ch === 'yuanbao') {
          channelConfigCommand = hermesChannelCmds.getYuanbaoConfigCommand({
            appKey: channelIdValue,
            appSecret: channelKeyValue || '',
          });
        } else if (ch === 'telegram') {
          channelConfigCommand = hermesChannelCmds.getTelegramConfigCommand({
            botToken: channelIdValue,
          });
        } else if (ch === 'discord') {
          channelConfigCommand = hermesChannelCmds.getDiscordConfigCommand({
            botToken: channelIdValue,
          });
        } else if (ch === 'slack') {
          channelConfigCommand = hermesChannelCmds.getSlackConfigCommand({
            botToken: channelIdValue,
            appToken: channelKeyValue || '',
          });
        } else if (ch === 'dingtalk') {
          channelConfigCommand = hermesChannelCmds.getDingtalkConfigCommand({
            clientId: channelIdValue,
            clientSecret: channelKeyValue || '',
          });
        }

        if (!channelConfigCommand) {
          setConfiguring(false);
          setCurrentAction('');
          return false;
        }

        const result = await executor.run({ command: channelConfigCommand });

        if (result.success) {
          setConfiguring(false);
          setCurrentAction('');
          await restartAndRefresh();
          return true;
        }

        setConfiguring(false);
        setCurrentAction('');
        return false;
      } catch {
        setConfiguring(false);
        setCurrentAction('');
        return false;
      }
    },
    [currentChannelList, executor, hermesChannelCmds, restartAndRefresh, setCurrentAction],
  );

  // ── 操作：删除通道 ──
  const deleteChannel = useCallback(
    async (channelValue: string): Promise<boolean> => {
      setDeletingChannel(channelValue);
      setCurrentAction('delete_channel');
      try {
        const command = hermesChannelCmds.getDeleteCommand(
          currentChannelList.find((c) => c.value === channelValue)?.channel || channelValue,
        );

        const result = await executor.run({ command });
        setDeletingChannel(null);
        setCurrentAction('');

        if (result.success) {
          await restartAndRefresh();
          return true;
        }
        return false;
      } catch {
        setDeletingChannel(null);
        setCurrentAction('');
        return false;
      }
    },
    [currentChannelList, executor, hermesChannelCmds, restartAndRefresh, setCurrentAction],
  );

  const handleRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return {
    configData,
    loading,
    currentChannelList,

    configureChannel,
    deleteChannel,
    refresh: handleRefresh,

    currentAction,
    configuring,
    deletingChannel,

    scriptCommands,
    executor,
    instance: params.instance,
    productConfig,
  };
}
