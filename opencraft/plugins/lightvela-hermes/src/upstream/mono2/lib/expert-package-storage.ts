// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 技能包安装状态的持久化（Vibebase 版）。
 *
 * 对齐 AI 搭子人设的“已注入”状态：
 * - 服务端真源：状态写到 Vibebase（用户级 KV），刷新 / 换浏览器也能恢复。
 * - 按 bot 隔离：不同 botId 各存一份，避免技能包安装状态串号。
 * - UI 层可保留 localStorage 兜底，但这里不做静默降级。
 *
 * Vibebase namespace / key：
 *   - namespace = `agent-state`
 *   - key       = `expert-packages.{botId}` 或 `expert-packages.__no_bot__`
 *   - value     = `ExpertPackagesStateV1` JSON
 */

import {
  getJSON,
  setJSON,
  VibebaseError,
} from "./vibebase-client";

const VIBEBASE_NAMESPACE = "agent-state";
const KEY_PREFIX = "expert-packages";
const NULL_BOT_KEY = "__no_bot__";

interface ExpertPackagesStateV1 {
  version: 1;
  installedPackageSlugs: string[];
  updatedAt: number;
}

export interface ExpertPackagesState {
  installedPackageSlugs: string[];
}

function buildKey(botId: string | null | undefined): string {
  return `${KEY_PREFIX}.${botId || NULL_BOT_KEY}`;
}

function normalizeSlugs(slugs: unknown): string[] {
  if (!Array.isArray(slugs)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of slugs) {
    if (typeof slug !== "string") continue;
    const normalized = slug.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export async function loadExpertPackagesState(
  botId: string | null | undefined,
): Promise<ExpertPackagesState | null> {
  const data = await getJSON<Partial<ExpertPackagesStateV1>>(
    VIBEBASE_NAMESPACE,
    buildKey(botId),
  );
  if (!data || data.version !== 1 || !Array.isArray(data.installedPackageSlugs)) {
    return null;
  }
  return {
    installedPackageSlugs: normalizeSlugs(data.installedPackageSlugs),
  };
}

export async function saveExpertPackagesState(
  botId: string | null | undefined,
  state: ExpertPackagesState,
): Promise<void> {
  const payload: ExpertPackagesStateV1 = {
    version: 1,
    installedPackageSlugs: normalizeSlugs(state.installedPackageSlugs),
    updatedAt: Date.now(),
  };
  await setJSON(VIBEBASE_NAMESPACE, buildKey(botId), payload);
}

export { VibebaseError };
