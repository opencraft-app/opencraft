/**
 * 企微长链接机器人快捷配置 - WecomAIBotSDK 接入 Hook
 * SDK 文档：https://www.npmjs.com/package/@wecom/wecom-aibot-sdk
 *
 * 语义对齐 tea-app-lighthouse master / @tencent/tea-sdk-lightclaw 的同名 Hook。
 * `@wecom/wecom-aibot-sdk` 作为 `@tencent/tea-sdk-lightclaw` 的传递依赖已在 lockfile 中，
 * 这里在 frontend/package.json 显式声明避免 phantom dependency。
 */
import WecomAIBotSDK from '@wecom/wecom-aibot-sdk';

const SOURCE = 'tencent-cloud-lighthouse';

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
    openAuth: () => WecomAIBotSDK.openBotInfoAuthWindow({ source: SOURCE }),
  };
}
