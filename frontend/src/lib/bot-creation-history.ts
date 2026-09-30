/**
 * 「是否曾经成功创建过 Bot」的账号级判定。
 *
 * 需求（wiki/prd-docs/2026-09-30-pricing-modal-and-first-bot-onboarding.md）：
 * 订阅生效后，从未成功创建过 Bot 的用户直接进入创建界面，非首次进入「我的智能体」。
 * 判据必须是「历史上是否成功创建过」，不能用「当前列表是否为空」替代 ——
 * 用户删掉全部 Bot 后仍应算非首次。
 *
 * 后端账号级标识尚未提供（PRD 待确认问题 1）。当前实现按 `session.user.id` 做用户隔离的
 * 本地持久化，作为过渡口径；后端提供可靠字段后，只需在调用方接入该字段，
 * 本文件的读写函数保持同一语义，不需要改调用点。
 */

const STORAGE_KEY_PREFIX = "lightvela:bot-created:";

/** 拿不到 user.id 时的兜底键（未登录 / session 缺失）。 */
const ANONYMOUS_STORAGE_KEY = `${STORAGE_KEY_PREFIX}anonymous`;

const isBrowser = (): boolean => typeof window !== "undefined";

const storageKeyFor = (userId?: string | null): string =>
  userId ? `${STORAGE_KEY_PREFIX}${userId}` : ANONYMOUS_STORAGE_KEY;

const safeGet = (key: string): string | null => {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    /* 隐私模式 / 存储被禁用时降级为「未记录」，不影响主链路 */
    return null;
  }
};

const safeSet = (key: string, value: string): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

/**
 * 订阅生效后的落点由调用方（订阅页收尾 / 登录后分流）决定：
 * - 从未成功创建过 Bot → 创建界面 `/agents?create=1`（命名向导，不自动创建实例）。
 * - 曾创建过 → `/agents`（正常列表；已删除全部 Bot 的用户也走这里）。
 */
export const hasEverCreatedBot = (userId?: string | null): boolean =>
  safeGet(storageKeyFor(userId)) === "1";

/** 创建成功后调用：标记该账号已成功创建过 Bot。 */
export const markBotCreated = (userId?: string | null): void => {
  safeSet(storageKeyFor(userId), "1");
};
