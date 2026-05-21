/**
 * AI 搭子人设抽卡的持久化（Vibebase 版）。
 *
 * 设计原则：
 * - **服务端真源**：状态写到 Vibebase（用户级 KV），跨设备 / 跨浏览器一致。
 * - **按 bot 隔离**：不同 botId 各存一份，避免互相串。
 * - **异步**：load/save 都是 Promise；UI 层负责加载态与失败提示。
 * - **错误透明**：失败原样抛 `VibebaseError`，由调用方（panel）决定是 toast
 *   还是降级。本模块**不做静默兜底**，避免数据不一致。
 *
 * Vibebase namespace / key：
 *   - namespace = `agent-state`
 *   - key       = `buddy.{botId}` 或 `buddy.__no_bot__`（未选 bot 时）
 *   - value     = `BuddyStateV1` JSON
 */

import type { SkillHubSoul } from "@/lib/skillhub-api";
import {
  deleteValue,
  getJSON,
  setJSON,
  VibebaseError,
} from "@/lib/vibebase-client";

const VIBEBASE_NAMESPACE = "agent-state";
const KEY_PREFIX = "buddy";
const NULL_BOT_KEY = "__no_bot__";

/** 持久化结构 v1（与 Vibebase 里的 schema 同步）。 */
interface BuddyStateV1 {
  version: 1;
  /** 已抽到的人设（保留完整字段，避免重启后再查 SkillHub） */
  drawnSouls: SkillHubSoul[];
  /** 当前已注入到 Bot 的 slug；null 表示无 */
  appliedSlug: string | null;
  /** 写入时间戳，仅作排查用 */
  updatedAt: number;
}

export interface BuddyState {
  drawnSouls: SkillHubSoul[];
  appliedSlug: string | null;
}

function buildKey(botId: string | null | undefined): string {
  return `${KEY_PREFIX}.${botId || NULL_BOT_KEY}`;
}

/**
 * 从 Vibebase 拉取当前 bot 的搭子状态。
 * - key 不存在 / 数据 schema 不匹配 → 返回 null（视为无数据）
 * - 401（未登录）等错误 → 抛 `VibebaseError`，由调用方处理
 */
export async function loadBuddyState(
  botId: string | null | undefined,
): Promise<BuddyState | null> {
  const data = await getJSON<Partial<BuddyStateV1>>(
    VIBEBASE_NAMESPACE,
    buildKey(botId),
  );
  if (!data || data.version !== 1 || !Array.isArray(data.drawnSouls)) {
    return null;
  }
  return {
    drawnSouls: data.drawnSouls,
    appliedSlug:
      typeof data.appliedSlug === "string" ? data.appliedSlug : null,
  };
}

/**
 * 写入当前 bot 的搭子状态。
 * 失败原样抛 `VibebaseError`，调用方决定 toast 还是重试。
 */
export async function saveBuddyState(
  botId: string | null | undefined,
  state: BuddyState,
): Promise<void> {
  const payload: BuddyStateV1 = {
    version: 1,
    drawnSouls: state.drawnSouls,
    appliedSlug: state.appliedSlug,
    updatedAt: Date.now(),
  };
  await setJSON(VIBEBASE_NAMESPACE, buildKey(botId), payload);
}

/**
 * 清空当前 bot 的搭子状态（重置抽卡盘）。
 * 不存在时静默成功。
 */
export async function clearBuddyState(
  botId: string | null | undefined,
): Promise<void> {
  await deleteValue(VIBEBASE_NAMESPACE, buildKey(botId));
}

/** 重新导出 VibebaseError，方便 panel 层 instanceof 判断未登录 / 配额等。 */
export { VibebaseError };
