/**
 * @fileoverview Hermes scripts 命令生成 —— 从 SDK `/scripts` 子入口获取
 *
 * 按迁移约定：命令生成（scripts 层）继续由 `@tencent/tea-sdk-lightclaw/scripts`
 * 提供，不迁进本地。该子入口是纯 TS、无浏览器 globals 副作用，可安全静态 import
 * （无需再走动态 import 规避 SSG —— 那套机制只对 SDK 主入口必要）。
 *
 * 这里只暴露 agent-settings-page 顶层实际用到的三个 Hermes 命令，避免在页面层
 * 直接耦合 scripts SDK 的对象结构。
 */

import { createLightClawScripts } from "@tencent/tea-sdk-lightclaw/scripts";

export interface IHermesProviderSaveConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: Array<{ id: string; name: string }>;
}

export interface IHermesScriptCommands {
  getGatewayRestartCommand: () => string;
  getProviderSaveCommand: (config: IHermesProviderSaveConfig) => string;
  getModelSwitchCommand: (modelFullId: string) => string;
}

let _cached: IHermesScriptCommands | null = null;

/** 获取 Hermes scripts 命令生成器（模块级缓存，等价于原 SDK runtime 的单例行为）。 */
export function getHermesScriptCommands(): IHermesScriptCommands {
  if (_cached) return _cached;
  const scripts = createLightClawScripts();
  const gateway = scripts.hermes.gateway;
  const model = scripts.hermes.model;
  _cached = {
    getGatewayRestartCommand: () => gateway.getRestartCommand(),
    getProviderSaveCommand: (config) => model.getProviderSaveCommand(config),
    getModelSwitchCommand: (modelFullId) => model.getModelSwitchCommand(modelFullId),
  };
  return _cached;
}
