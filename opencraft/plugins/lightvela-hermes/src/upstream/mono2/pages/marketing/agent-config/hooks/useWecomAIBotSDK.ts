// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 企微长链接机器人快捷配置 - WecomAIBotSDK 接入 Hook
 * SDK 文档：https://www.npmjs.com/package/@wecom/wecom-aibot-sdk
 *
 * 语义对齐 tea-app-lighthouse master / @tencent/tea-sdk-lightclaw 的同名 Hook。
 * `@wecom/wecom-aibot-sdk` 作为 `@tencent/tea-sdk-lightclaw` 的传递依赖已在 lockfile 中，
 * 这里在 frontend/package.json 显式声明避免 phantom dependency。
 *
 * ⚠️ SSR 约束（治本，勿改回静态 import）：
 * `@wecom/wecom-aibot-sdk` 的 ESM 入口在【模块顶层】无条件执行
 * `const sdk = new WecomAIBotSDK()`，其构造函数 → `setupMessageListener()` →
 * `window.addEventListener('message', ...)` 直接裸访问 `window`（顶层仅
 * `window.WecomAIBotSDK = sdk` 一行有 typeof 守卫，构造本身没有）。因此只要
 * 【静态】import 本包，就会把 window 副作用打进 SSR 依赖链，Next.js 静态导出
 * 预渲染 `/agents/*` 时抛 `ReferenceError: window is not defined`
 * （栈顶 `setupMessageListener`）。
 *
 * 解决：改为在 `openAuth` 被调用时（仅用户交互、浏览器端）【动态】import，
 * 从源头把该包排除出 SSR 求值时机。openAuth 本就是异步返回，契约不变。
 */
import type WecomAIBotSDKType from '@wecom/wecom-aibot-sdk';

const SOURCE = 'tencent-cloud-lighthouse';

type OpenBotInfoAuthWindowParams = Parameters<
  typeof WecomAIBotSDKType.openBotInfoAuthWindow
>[0];
type OpenBotInfoAuthWindowReturn = ReturnType<
  typeof WecomAIBotSDKType.openBotInfoAuthWindow
>;

/**
 * 企微长链接机器人扫码创建 Hook
 *
 * @returns openAuth - 调用后弹出扫码授权窗口，返回 BotInfo { botid, secret }
 *
 * @example
 * const { openAuth } = useWecomAIBotSDK();
 * const handleClick = async () => {
 *   try {
 *     const bot = await openAuth();
 *     // bot.botid, bot.secret -> 写入通道配置
 *   } catch (e) {
 *     console.error(e);
 *   }
 * };
 */
export function useWecomAIBotSDK() {
  return {
    openAuth: async (): OpenBotInfoAuthWindowReturn => {
      const mod = await import('@wecom/wecom-aibot-sdk');
      const sdk = mod.default;
      const params: OpenBotInfoAuthWindowParams = { source: SOURCE };
      return sdk.openBotInfoAuthWindow(params);
    },
  };
}
