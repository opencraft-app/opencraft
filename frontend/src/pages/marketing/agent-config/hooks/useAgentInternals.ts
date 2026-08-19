import { useMemo } from 'react';
import {
  createLightClawScripts,
  type LightClawScriptsSDK,
} from "@tencent/tea-sdk-lightclaw/scripts";
import { createLighthouseConfig } from '../product-config';
import { useGatewayCommand } from './useGatewayCommand';
import type { ICommandExecutor } from '../local-command-executor';
import type { IProductConfig } from '../types';
import type { IFeatureFlags, IInstanceInfo, IExecuteCommandOptions } from '../types';

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
export interface IAgentComponentBaseProps {
  /** 实例信息（必传） */
  instance: IInstanceInfo;
  /** 外部注入的 scriptCommands 实例（可选；不传则 SDK 内部使用默认值创建） */
  scriptCommands?: LightClawScriptsSDK;
  /** 功能特性标志（必传） */
  featureFlags: IFeatureFlags;
  /**
   * 产品差异化配置（可选，默认使用 lighthouse 配置）
   */
  productConfig?: IProductConfig;
  /**
   * 命令执行器（由宿主注入）。
   *
   * mono2 走本地 `createLocalCommandExecutor`（直连 debug/exec），彻底脱离
   * SDK 的 TAT 两步式执行逻辑。不传则内部 fallback 到一个安全的空 executor
   * （仅用于无 bot 场景占位，实际不会被触发）。
   */
  commandExecutor?: ICommandExecutor;
}

// ============================================================
// Hook 返回值类型
// ============================================================

export interface IAgentInternalsResult {
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
 * 抽成可复用 hook，避免各组件重复实现初始化逻辑。
 */
export function useAgentInternals(props: IAgentComponentBaseProps): IAgentInternalsResult {
  const { featureFlags: _featureFlags } = props;

  // 1. 解析 productConfig
  const productConfig = props.productConfig ?? createLighthouseConfig();

  // 2. 创建 / 复用 scriptCommands
  // SDK 内部已硬编码 gz 地域 + 默认 COS bucket,无需传任何参数;
  // 消费方仍可通过 props.scriptCommands 注入自定义实例。
  const internalScriptCommands = useMemo(() => createLightClawScripts(), []);
  const scriptCommands = props.scriptCommands ?? internalScriptCommands;

  // 3. 解析 executor
  //
  // 优先使用宿主注入的 commandExecutor（mono2 走本地 createLocalCommandExecutor，
  // 直连 debug/exec）。未注入时 fallback 到一个安全的空 executor —— 仅用于无 bot
  // 场景占位，实际操作路径不会触发（宿主保证有 bot 时才注入真实 executor）。
  const executor = useMemo<ICommandExecutor>(
    () =>
      props.commandExecutor ?? {
        run: async () => {
          throw new Error("[useAgentInternals] commandExecutor 未注入");
        },
        runWithProgress: async () => {
          throw new Error("[useAgentInternals] commandExecutor 未注入");
        },
      },
    [props.commandExecutor],
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
