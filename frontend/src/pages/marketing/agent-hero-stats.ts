/**
 * 总览页横幅的真实数据
 * ──────────────────────────────────────────────────────────────
 * 三个来源各不相同，这里统一成一个 hook：
 *   - 服务天数 / 有效期 / 剩余积分 ← `activePass`（GET /v1/passes，已由 useOpenClaw 提供）
 *   - 定时任务数                  ← `listCronJobs`（沙箱 `hermes cron list`）
 *   - 创建站点数                  ← GET /v1/websites/capability
 *
 * 拉不到的项返回 null，由 UI 显示占位符而不是 0 —— 免得未订阅用户
 * 看到「剩余积分 0」以为额度被清空。
 */

import { useEffect, useState } from "react";

import type { Pass } from "@/domain/types";
import { listCronJobs } from "@/lib/hermes-cron-client";
import { isCronJobExpired } from "@/pages/marketing/agent-automations-panel";
import type { HeroStats } from "@/pages/marketing/agent-overview-panel";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** created_time 起算的已服务天数；至少显示 1 天（当天订阅不该显示 0） */
export const computeServedDays = (createdTime: string | undefined, now = Date.now()): number | null => {
  if (!createdTime) return null;
  const start = new Date(createdTime).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(1, Math.floor((now - start) / MS_PER_DAY) + 1);
};

/** 有效期至（本地化日期串） */
export const formatExpiryDate = (expiredTime: string | undefined, locale = "zh-CN"): string | null => {
  if (!expiredTime) return null;
  const end = new Date(expiredTime);
  if (Number.isNaN(end.getTime())) return null;
  return end.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
};

/** 读已创建站点数；接口不可用时返回 null 而不是 0 */
const fetchUsedSites = async (): Promise<number | null> => {
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (!baseUrl) return null;
  const token = readStoredAuthToken();
  if (!token) return null;
  try {
    const response = await fetch(`${baseUrl}/v1/websites/capability`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { used_sites?: number };
    return typeof payload.used_sites === "number" ? payload.used_sites : null;
  } catch {
    return null;
  }
};

export const useHeroStats = (params: {
  activePass: Pass | null;
  botId: string | undefined;
  profileId: string | undefined;
  locale?: string;
  refreshKey?: number;
}): HeroStats => {
  const { activePass, botId, profileId, locale, refreshKey } = params;

  const [automations, setAutomations] = useState<number | null>(null);
  const [sites, setSites] = useState<number | null>(null);

  useEffect(() => {
    setAutomations(null);
    if (!botId) return undefined;
    let cancelled = false;

    void (async () => {
      try {
        const jobs = await listCronJobs(
          profileId ? { instanceId: botId, profileId } : botId,
          { hydrateContextFrom: false },
        );
        if (!cancelled) {
          // 只算生效中的，过期任务不该占数字
          setAutomations(jobs.filter((job) => !isCronJobExpired(job)).length);
        }
      } catch {
        if (!cancelled) setAutomations(null);
      }
    })();

    return () => { cancelled = true; };
  }, [botId, profileId, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const used = await fetchUsedSites();
      if (!cancelled) setSites(used);
    })();
    return () => { cancelled = true; };
  }, []);

  return {
    servedDays: computeServedDays(activePass?.created_time),
    expiresAt: formatExpiryDate(activePass?.expired_time, locale),
    credits: activePass ? activePass.credit_available : null,
    automations,
    sites,
  };
};
