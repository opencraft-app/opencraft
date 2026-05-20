/**
 * AI 搭子人设抽卡的本地持久化（localStorage 版）。
 *
 * 设计原则：
 * - **按 bot 隔离**：不同 botId 各存一份，避免互相串。
 * - **薄抽象**：只对外暴露 `loadBuddyState / saveBuddyState`，底层是 localStorage。
 *   后续切到后端数据库（持久化到 Cert / 用户态）时，**只需要替换这两个函数实现**，
 *   `openclaw-buddy-panel.tsx` 不用动。
 * - **格式 schema 化**：带 version 号 + drawnSouls 完整字段（不只 slug），
 *   重启时不用再请求 SkillHub 列表就能立即渲染卡面。
 *
 * 失败处理：localStorage 不可用 / JSON 解析失败 / 版本不匹配 → 全部当无数据。
 * 没有也不影响功能（只是回到空抽卡盘）。
 */

import type { SkillHubSoul } from "@/lib/skillhub-api";

const KEY_PREFIX = "lightclaw.buddy.state.v1";
const NULL_BOT_KEY = "__no_bot__";

/** 持久化结构 v1 */
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

function storageKey(botId: string | null | undefined): string {
  return `${KEY_PREFIX}.${botId || NULL_BOT_KEY}`;
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / iframe 跨站策略 → 拿不到 localStorage
    return null;
  }
}

export function loadBuddyState(botId: string | null | undefined): BuddyState | null {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(storageKey(botId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuddyStateV1>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.drawnSouls)) return null;
    return {
      drawnSouls: parsed.drawnSouls,
      appliedSlug: typeof parsed.appliedSlug === "string" ? parsed.appliedSlug : null,
    };
  } catch {
    return null;
  }
}

export function saveBuddyState(botId: string | null | undefined, state: BuddyState): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    const payload: BuddyStateV1 = {
      version: 1,
      drawnSouls: state.drawnSouls,
      appliedSlug: state.appliedSlug,
      updatedAt: Date.now(),
    };
    ls.setItem(storageKey(botId), JSON.stringify(payload));
  } catch {
    // 配额满 / 写失败 → 静默丢弃；下次再试
  }
}

export function clearBuddyState(botId: string | null | undefined): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.removeItem(storageKey(botId));
  } catch {
    // ignore
  }
}
