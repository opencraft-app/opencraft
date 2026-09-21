/**
 * 新订阅用户标记
 * ──────────────────────────────────────────────────────────────
 * 配置引导只对「刚订阅完、第一次进来」的用户展示。
 *
 * 为什么不能只看「SOUL.md 不存在」：
 *   老用户里也有从没配过人设的，只看 SOUL 会把他们突然拉进引导页。
 *   所以必须叠加一个「这个 bot 是刚创建出来的」标记。
 *
 * 标记在 `?creating=` 流程走完时写入，引导完成后清除。
 * 用 sessionStorage 而非 localStorage：关掉标签页就失效，
 * 避免标记残留导致下次登录又弹引导。
 */

import { isCN } from "@/lib/region";

const STORAGE_KEY = "lv-pending-onboarding-bots";

/**
 * 新建 bot 引导流程的区域开关。
 *
 * 分区域上线：国内站（lightvela.com）先上，国际站（lightvela.ai）保持原有
 * 流程（创建后直落「通道」tab，无引导表单、无总览页）。
 *
 * 国际站上线时把这里改成 `true` 即可 —— 三个消费点都读它：
 *   1. shouldShowEarlyOnboarding()            创建期前置引导
 *   2. agent-settings-page 的 showBuddyOnboarding  已有 bot 的补配引导
 *   3. agent-settings-page 的 DEFAULT_AGENT_SECTION / 总览入口
 *
 * isCN 是编译期常量，国际站构建时这些分支会被直接折叠掉，不进产物。
 *
 * TODO(intl-onboarding): 国际站上线后删除本开关与相关分支，避免长期留着死代码。
 */
export const IS_BUDDY_ONBOARDING_ENABLED = isCN;

const readSet = (): Set<string> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((item): item is string => typeof item === "string"))
      : new Set();
  } catch {
    // 数据被手改坏了就当作空集，不让它把引导判定搞崩
    return new Set();
  }
};

const writeSet = (value: Set<string>) => {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...value]));
};

/** 标记某个 bot 刚创建完，待走配置引导 */
export const markPendingOnboarding = (botId: string) => {
  if (!botId) return;
  const set = readSet();
  set.add(botId);
  writeSet(set);
};

/** 该 bot 是否待走配置引导 */
export const isPendingOnboarding = (botId: string | undefined): boolean => (
  Boolean(botId) && readSet().has(botId!)
);

/** 引导完成，清除标记 */
export const clearPendingOnboarding = (botId: string) => {
  if (!botId) return;
  const set = readSet();
  if (!set.delete(botId)) return;
  writeSet(set);
};

/**
 * 是否在实例创建期就直接展示引导表单（取代「等实例」那次咖啡杯）。
 *
 * 为什么不要求 botId：
 *   创建入口是 `setIsCreating(true)` 紧接着 `navigate(?creating=<botId>)`，
 *   这两步之间至少有一帧 isCreating=true 但 URL 还没带上 botId；
 *   另有 `?creating=true` 这种不带 botId 的路径。
 *   如果把 botId 当硬条件，这些窗口就会漏回咖啡杯 —— 也就是用户看到的
 *   「第一个咖啡杯」。所以 botId 只用来查打标，不作为前置门槛。
 *
 * 为什么不要求打标：
 *   打标发生在「URL 出现 ?creating=」之后的 effect 里，同样晚于 isCreating。
 *   创建期本身已经足够说明「这是个刚建的实例」，不需要再要打标来确认。
 *
 * 几个必须让位的情况：
 *   - creationError：实例没建起来，要让用户看到错误，不能盖住
 *   - isModifying：套餐升级态有自己的页面
 *   - onboardingJustFinished：刚填完，别又弹回表单
 *
 * enabled 走参数而非直接读 IS_BUDDY_ONBOARDING_ENABLED：isCN 是编译期常量，
 * 单个测试进程只看得到一个区域，传参才能在一次测试里覆盖两个站。
 * 默认值取真实开关，调用方不必每处都传。
 */
export const shouldShowEarlyOnboarding = (input: {
  isCreating: boolean;
  isModifying: boolean;
  hasCreationError: boolean;
  onboardingJustFinished: boolean;
  enabled?: boolean;
}): boolean => {
  if (!(input.enabled ?? IS_BUDDY_ONBOARDING_ENABLED)) return false;
  if (!input.isCreating) return false;
  if (input.isModifying || input.hasCreationError || input.onboardingJustFinished) return false;
  return true;
};

/**
 * 这一帧是否真的有侧边栏。
 *
 * `lv-agent-sidebar-header` / `-settings-main` / `-settings-shell` 三个 class
 * 是给 264px 侧边栏让位用的，必须与侧边栏同时出现，否则会留下一块占了宽度
 * 却空无一物的竖条。
 *
 * 判定直接对齐侧边栏自身的渲染条件（`!isCreating && activeBot`），
 * 而不是「是否在创建期引导」—— 后者依赖 isCreating，而从首页 hero 进入时
 * URL 不带 `?creating=`，isCreating 要等 bots 拉完才转 true。那段窗口里
 * 两者都为 false，但 activeBot 也还没有（provisioning 实例被 visibleBots
 * 过滤掉），侧边栏并不存在 —— 表现为「首次进入左侧空白、刷新后才正常」。
 */
export const hasAgentSidebarLayout = (input: {
  isCreating: boolean;
  hasActiveBot: boolean;
}): boolean => !input.isCreating && input.hasActiveBot;

/** 创建中的目标变为 active 后仍从完整列表解析，绝不借用其他 Bot 的 profile。 */
export const resolveOnboardingProfileId = (
  bots: readonly { id: string; profileId?: string }[],
  botId: string,
): string => botId ? bots.find((bot) => bot.id === botId)?.profileId ?? "" : "";
