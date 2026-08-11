import { useMemo } from 'react';
import {
  createLightClawScripts,
  createCommandExecutor,
  type LightClawScriptsSDK,
  type ICommandExecutor,
} from "@tencent/tea-sdk-lightclaw/scripts";
import { createLighthouseConfig } from '../config';
import { useGatewayCommand } from './useGatewayCommand';
import type { IProductConfig } from '../config/types';
import type { IFeatureFlags, IInstanceInfo, IExecuteCommandOptions } from '../openclaw-panel/types';

// ============================================================
// 独立组件公共 Props 基类
// ============================================================

/**
 * 所有独立输出组件的公共 Props 基类。
 *
 * 消费方只需提供 instance + featureFlags 即可，
 * 组件内部会自动创建 scriptCommands / executor / useGatewayCommand。
 *
 * 也可通过 scriptCommands 直接注入（适用于需要扩展命令的产品定制场景）。
 */
export interface IOpenClawComponentBaseProps {
  /** 实例信息（必传） */
  instance: IInstanceInfo;
  /** 外部注入的 scriptCommands 实例（可选；不传则 SDK 内部使用默认值创建） */
  scriptCommands?: LightClawScriptsSDK;
  /** 功能特性标志（必传） */
  featureFlags: IFeatureFlags;
  /**
   * 产品差异化配置（可选，默认使用 lighthouse 配置）
   * 自定义 runCommand / getInvocationTask 也在此配置中注入
   */
  productConfig?: IProductConfig;
}

// ============================================================
// Hook 返回值类型
// ============================================================

export interface IOpenClawInternalsResult {
  /** 解析后的 scriptCommands 实例 */
  scriptCommands: LightClawScriptsSDK;
  /** 命令执行器 */
  executor: ICommandExecutor;
  /** 解析后的产品配置（含默认值 fallback） */
  productConfig: IProductConfig;
  /** 通用命令执行函数 */
  executeGatewayCommand: (options: IExecuteCommandOptions) => Promise<void>;
  /** 当前操作标识（用于 loading 状态） */
  currentAction: string;
  /** 设置当前操作标识 */
  setCurrentAction: React.Dispatch<React.SetStateAction<string>>;
  /** 重启网关 */
  restartGateway: (showLoading?: boolean) => Promise<void>;
  /** 查询网关状态 */
  queryGatewayStatus: () => Promise<void>;
  /** 网关状态 */
  gatewayStatus: string;
  /** 网关 loading */
  gatewayLoading: boolean;
}

// ============================================================
// Hook 实现
// ============================================================

/**
 * 封装独立组件的公共初始化逻辑：
 *
 * 1. 解析 / 创建 scriptCommands
 * 2. 创建 executor
 * 3. 调用 useGatewayCommand 获得命令执行能力
 * 4. 解析 productConfig（不传使用 lighthouse 默认值）
 *
 * 等价于 OpenClawPanel/index.tsx 中 44-61 行的初始化逻辑，
 * 抽成可复用 hook 避免各组件重复实现。
 */
export function useOpenClawInternals(props: IOpenClawComponentBaseProps): IOpenClawInternalsResult {
  const { instance, featureFlags: _featureFlags } = props;

  // 1. 解析 productConfig
  const productConfig = props.productConfig ?? createLighthouseConfig();

  // 2. 创建 / 复用 scriptCommands
  // SDK 内部已硬编码 gz 地域 + 默认 COS bucket,无需传任何参数;
  // 消费方仍可通过 props.scriptCommands 注入自定义实例。
  const internalScriptCommands = useMemo(() => createLightClawScripts(), []);
  const scriptCommands = props.scriptCommands ?? internalScriptCommands;

  // 3. 创建 executor（自定义 runCommand / getInvocationTask / tatRunAs 从 productConfig 中获取）
  const executor = useMemo(
    () =>
      createCommandExecutor({
        instance,
        runCommand: productConfig.runCommand,
        getInvocationTask: productConfig.getInvocationTask,
        runAs: productConfig.tatRunAs,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      instance.InstanceId,
      instance.RegionId,
      productConfig.runCommand,
      productConfig.getInvocationTask,
      productConfig.tatRunAs,
    ],
  );

  // 4. 创建 useGatewayCommand
  const {
    gatewayLoading,
    currentAction,
    status: gatewayStatus,
    setCurrentAction,
    executeGatewayCommand,
    queryGatewayStatus,
    restartGateway,
  } = useGatewayCommand({ scriptCommands, executor });

  return {
    scriptCommands,
    executor,
    productConfig,
    executeGatewayCommand,
    currentAction,
    setCurrentAction,
    restartGateway,
    queryGatewayStatus,
    gatewayStatus,
    gatewayLoading,
  };
}
