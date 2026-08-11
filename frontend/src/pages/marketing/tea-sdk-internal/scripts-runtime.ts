/**
 * @fileoverview Hermes scripts 命令生成 —— 从 SDK `/scripts` 子入口获取
 *
 * 按迁移约定：命令生成（scripts 层）继续由 `@tencent/tea-sdk-lightclaw/scripts`
 * 提供，不迁进本地。
 *
 * ⚠️ SSR 约束：`@tencent/tea-sdk-lightclaw/scripts` 的
 * `scripts/commands/hermes.ts` 顶层 import 了 `@tencent/tea-app` 的 i18n，
 * 而 tea-app 的 `core/i18n.tsx` 在**模块顶层直接访问 `window`**。
 * 因此该子入口**不能静态 import**——否则会被打进 agent-settings-page 的
 * 服务端渲染依赖链，导致 Next.js `next build` 预渲染 `/agents/*` 页面时
 * 抛 `ReferenceError: window is not defined`。
 *
 * 解决：改为**运行时动态 import**（仅浏览器端、用户操作时才加载），
 * 把带 window 副作用的 scripts SDK 排除出 SSR 依赖链。
 * 消费方全部在 async 回调中调用，天然可 `await`。
 *
 * 这里只暴露 agent-settings-page 顶层实际用到的三个 Hermes 命令，避免在页面层
 * 直接耦合 scripts SDK 的对象结构。
 */

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

/**
 * 获取 Hermes scripts 命令生成器（模块级缓存，等价于原 SDK runtime 的单例行为）。
 *
 * 通过动态 import 加载 SDK `/scripts` 子入口，规避其 tea-app i18n 顶层 window
 * 副作用污染 SSR 依赖链。首次调用异步加载并缓存，后续同一会话内复用缓存。
 */
export async function getHermesScriptCommands(): Promise<IHermesScriptCommands> {
  if (_cached) return _cached;
  const { createLightClawScripts } = await import("@tencent/tea-sdk-lightclaw/scripts");
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
