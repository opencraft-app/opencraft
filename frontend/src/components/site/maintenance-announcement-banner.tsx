/**
 * 首页公告条。
 *
 * 显示位置：仅 landing（"/"）页顶部。
 * 显示条件：国内站或国际站首页、存在未过期且未关闭的公告。
 * 布局方式：普通文档流顶部条，出现时把首页整体向下推，避免覆盖首屏内容。
 *
 * 关闭行为：localStorage key 按公告 ID 分别记忆；下一次发新公告时换 ID 即可重新弹。
 */

import { Megaphone, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/i18n/t";
import { stripPublicSiteLocalePrefix } from "@/lib/public-site-routing";
import { isCN, isGlobal } from "@/lib/region";

type AnnouncementItem = {
  id: string;
  message: string;
  expiresAt: number;
};

const HERMES_UPGRADE_ANNOUNCEMENT_ID = "0907-hermes-agent-upgrade";

/** 北京时间 / 新加坡时间 2026-09-08 02:00:00 = UTC 2026-09-07 18:00:00 */
const HERMES_UPGRADE_EXPIRES_AT = Date.UTC(
  2026,
  8 /* 0-indexed: September */,
  7,
  18,
  0,
  0,
);
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

/** 显示的路径白名单。国际站会先剥离 /en-us、/zh-cn、/zh-sg 等语言前缀。 */
const VISIBLE_PATHS = new Set<string>(["/"]);

/** 公告条占据的页面高度（px）。 */
export const ANNOUNCEMENT_BANNER_HEIGHT_PX = 36;

function getStorageKey(id: string) {
  return `lw-announcement-dismissed:${id}`;
}

export function MaintenanceAnnouncementBanner() {
  const t = useT();
  const pathname = usePathname();
  const announcement: AnnouncementItem = {
    id: HERMES_UPGRADE_ANNOUNCEMENT_ID,
    expiresAt: HERMES_UPGRADE_EXPIRES_AT,
    message: isGlobal
      ? t(
          "LightVela 将于新加坡时间 2026 年 9 月 7 日 22:00-次日 02:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
        )
      : t(
          "LightVela 将于北京时间 2026 年 9 月 7 日 22:00-次日 02:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
        ),
  };
  // 默认不显示，挂载时再读 localStorage —— 避免 SSR / 首屏 flash 不一致
  const [dismissedIds, setDismissedIds] = useState<Set<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      const nextDismissedIds = new Set<string>();
      if (
        window.localStorage.getItem(
          getStorageKey(HERMES_UPGRADE_ANNOUNCEMENT_ID),
        ) === "1"
      ) {
        nextDismissedIds.add(HERMES_UPGRADE_ANNOUNCEMENT_ID);
      }
      setDismissedIds(nextDismissedIds);
    } catch {
      // 隐私模式 / 禁用 storage：当作未关闭，正常显示
      setDismissedIds(new Set());
    }
  }, []);

  // 用户挂着浏览器跨过撤下时间的场景：不依赖刷新 / 切路由，到点强制隐藏最早过期的公告。
  // setTimeout 上限约 24 天；距离过期太久时跳过定时器，后续访问会重新计算过期状态。
  useEffect(() => {
    const remaining = HERMES_UPGRADE_EXPIRES_AT - now;
    if (remaining <= 0) return;
    if (remaining > MAX_SAFE_TIMEOUT_MS) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [now]);

  const hasActiveAnnouncement =
    dismissedIds !== null &&
    now < announcement.expiresAt &&
    !dismissedIds.has(announcement.id);

  const visible =
    (isCN || isGlobal) &&
    pathname !== null &&
    VISIBLE_PATHS.has(stripPublicSiteLocalePrefix(pathname)) &&
    hasActiveAnnouncement;

  useEffect(() => {
    document.body.classList.toggle("lw-has-announcement", visible);
    return () => {
      document.body.classList.remove("lw-has-announcement");
    };
  }, [visible]);

  if (!visible) return null;

  const dismissActiveAnnouncement = () => {
    try {
      window.localStorage.setItem(getStorageKey(announcement.id), "1");
    } catch {
      /* 写不进去也无妨，本次 session 视觉上隐藏即可 */
    }
    setDismissedIds((current) => {
      const nextDismissedIds = new Set(current ?? []);
      nextDismissedIds.add(announcement.id);
      return nextDismissedIds;
    });
  };

  return (
    <div
      // 公告条强制 36px 单行高（h-9）。正文在可用宽度内居中；过长时
      // 自动外边距归零，从开头横向滚动。左右等宽安全区确保视觉中心
      // 与页面中心一致，并避免关闭按钮遮住文案。
      className="relative flex h-9 items-center justify-center border-b border-amber-300 bg-amber-50 px-4 text-xs text-amber-950 shadow-sm 2xl:text-sm"
      role="status"
      aria-live="polite"
    >
      <div className="mx-8 flex min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
        <span className="mx-auto inline-flex shrink-0 items-center gap-2 leading-9">
          <Megaphone className="size-4 shrink-0" aria-hidden="true" />
          {announcement.message}
        </span>
      </div>
      <button
        type="button"
        aria-label={t("关闭公告")}
        onClick={dismissActiveAnnouncement}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-amber-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
