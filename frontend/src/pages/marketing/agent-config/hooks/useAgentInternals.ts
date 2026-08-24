import { useMemo, useSyncExternalStore } from 'react';
// ⚠️ SSR 约束（治本，非页面层绕过）：
// `@tencent/tea-sdk-lightclaw/scripts` 的 `scripts/commands/hermes.js` 顶层
// `import { t } from '@tencent/tea-app/lib/i18n'`，而 tea-app 的 i18n 在模块
// 顶层直接访问 `window`。只要本文件【静态】import 该子入口，就会把 window 副作用
// 打进任何引用本 hook 的模块（含 barrel）的 SSR 依赖链，导致 Next.js 静态导出
// 预渲染 `/agents/*` 时抛 `ReferenceError: window is not defined`（副作用使
// tree-shake 失效，无论运行时是否执行到）。
//
// 解决：此处只保留**类型** import（编译期擦除、无运行时副作用），真正的
// `createLightClawScripts` 改为**运行时动态 import**（仅浏览器端惰性加载），
// 从源头把 scripts SDK 排除出 SSR 依赖链。这样 barrel 恢复安全，消费方无需再
// 用子路径导入 / 客户端骨架等页面层绕过手段。
import type { LightClawScriptsSDK } from "@tencent/tea-sdk-lightclaw/scripts";
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
  /** scripts SDK 是否已就绪（false 时 scriptCommands 为占位符，命令方法返回空串） */
  scriptsReady: boolean;
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
// scripts SDK 惰性加载 store（仅浏览器端）
// ============================================================
//
// createLightClawScripts 的求值会连带求值带 window 副作用的 tea-app i18n，
// 因此不能在 SSR 期执行、也不能静态 import。这里用「模块级同步缓存 +
// useSyncExternalStore 订阅」暴露一个**同步快照**：
//   - 首帧（含 SSR、以及客户端尚未加载完成时）：返回安全占位实例；
//   - 客户端首次消费触发动态 import，就绪后 store 通知重渲染，返回真实实例。
// 下游对 scriptCommands 的属性访问均为「取命令字符串 → 交给 executor.run」，
// 而真实命令执行由用户交互驱动、发生在加载完成之后，故占位期间不会被真正触发。

let _sdkInstance: LightClawScriptsSDK | null = null;
let _sdkPromise: Promise<LightClawScriptsSDK> | null = null;
const _listeners = new Set<() => void>();

// 稳定的占位快照：属性访问不抛错，命令串返回空（不会被 executor 真正执行）。
// 用 Proxy 递归返回自身/空串，避免为 SDK 的深层命令结构手写占位。
const _placeholder: LightClawScriptsSDK = new Proxy(function () {} as never, {
  get: () => _placeholder,
  apply: () => '',
}) as LightClawScriptsSDK;

function _emit(): void {
  for (const l of _listeners) l();
}

// 惰性加载 scripts SDK，返回 Promise（可被需要真实命令的异步流程 await）。
// 用模块级缓存保证同一实例只 import 一次；失败后清空缓存允许下次重试。
function _ensureSdkLoaded(): Promise<LightClawScriptsSDK> {
  if (_sdkInstance) return Promise.resolve(_sdkInstance);
  if (typeof window === 'undefined') return Promise.resolve(_placeholder); // SSR 期不加载
  if (!_sdkPromise) {
    _sdkPromise = import("@tencent/tea-sdk-lightclaw/scripts")
      .then(({ createLightClawScripts }) => {
        _sdkInstance = createLightClawScripts();
        _emit();
        return _sdkInstance;
      })
      .catch((err) => {
        _sdkPromise = null; // 失败后允许下次重试
        console.error('[useAgentInternals] 加载 tea-sdk-lightclaw/scripts 失败:', err);
        throw err;
      });
  }
  return _sdkPromise;
}

/** 等待 scripts SDK 就绪（供非 hook 场景或需要真实命令的异步流程 await） */
export function ensureScriptsReady(): Promise<LightClawScriptsSDK> {
  return _ensureSdkLoaded();
}

function _subscribe(onChange: () => void): () => void {
  _listeners.add(onChange);
  void _ensureSdkLoaded();
  return () => {
    _listeners.delete(onChange);
  };
}

function _getSnapshot(): LightClawScriptsSDK {
  return _sdkInstance ?? _placeholder;
}

/**
 * 订阅惰性加载的 scripts SDK 实例。
 *
 * SSR 与加载完成前返回安全占位（属性访问不崩、命令返回空串）；客户端加载完成
 * 后返回真实实例并触发重渲染。等价于原 `useMemo(() => createLightClawScripts())`
 * 的单例语义，但把 window 副作用移出 SSR 求值时机。
 */
function useLazyLightClawScripts(): LightClawScriptsSDK {
  return useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);
}

/** 订阅 scripts SDK 是否就绪（false = 仍为占位符，命令方法返回空串，不可用于真实执行） */
function useScriptsReady(): boolean {
  return useSyncExternalStore(
    _subscribe,
    () => _sdkInstance !== null,
    () => false,
  );
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
  // scripts SDK 通过惰性动态 import 加载（见上方 store 说明），规避其 tea-app
  // i18n 顶层 window 副作用污染 SSR 依赖链。消费方仍可通过 props.scriptCommands
  // 注入自定义实例（此时不触发内部惰性加载路径的真实使用）。
  const internalScriptCommands = useLazyLightClawScripts();
  const scriptCommands = props.scriptCommands ?? internalScriptCommands;
  const scriptsReady = useScriptsReady();

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
    scriptsReady,
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
