/**
 * 首页公告条。
 *
 * 显示位置：仅 landing（"/"）页顶部。
 * 显示条件：国内站或国际站首页、存在未过期且未关闭的公告。
 * 布局方式：普通文档流顶部条，出现时把首页整体向下推，避免覆盖首屏内容。
 *
 * 关闭行为：localStorage key 按公告 ID 分别记忆；下一次发新公告时换 ID 即可重新弹。
 */

import { ChevronLeft, ChevronRight, Megaphone, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/i18n/t";
import { stripPublicSiteLocalePrefix } from "@/lib/public-site-routing";
import { isCN, isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

type AnnouncementItem = {
  id: string;
  message: string;
  expiresAt: number;
  href?: string;
  actionLabel?: string;
};

/** 公告顺序即轮播顺序。 */
const HERMES_UPGRADE_ANNOUNCEMENT_ID = "0907-hermes-agent-upgrade";
const GLOBAL_PUBLIC_BETA_BILLING_ANNOUNCEMENT_ID =
  "0818-global-public-beta-billing-announcement";
const ANNOUNCEMENT_IDS = [
  HERMES_UPGRADE_ANNOUNCEMENT_ID,
  GLOBAL_PUBLIC_BETA_BILLING_ANNOUNCEMENT_ID,
] as const;

/** 北京时间 / 新加坡时间 2026-09-08 02:00:00 = UTC 2026-09-07 18:00:00 */
const HERMES_UPGRADE_EXPIRES_AT = Date.UTC(
  2026,
  8 /* 0-indexed: September */,
  7,
  18,
  0,
  0,
);
/** 新加坡时间 2026-09-18 00:00:00 = UTC 2026-09-17 16:00:00 */
const GLOBAL_PUBLIC_BETA_BILLING_EXPIRES_AT = Date.UTC(
  2026,
  8 /* 0-indexed: September */,
  17,
  16,
  0,
  0,
);
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;
const CAROUSEL_INTERVAL_MS = 6_000;

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
  const announcements: AnnouncementItem[] = [
    {
      id: HERMES_UPGRADE_ANNOUNCEMENT_ID,
      expiresAt: HERMES_UPGRADE_EXPIRES_AT,
      message: isGlobal
        ? t(
            "LightVela 将于新加坡时间 2026 年 9 月 7 日 22:00-次日 02:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
          )
        : t(
            "LightVela 将于北京时间 2026 年 9 月 7 日 22:00-次日 02:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
          ),
    },
    ...(isGlobal
      ? [
          {
            id: GLOBAL_PUBLIC_BETA_BILLING_ANNOUNCEMENT_ID,
            expiresAt: GLOBAL_PUBLIC_BETA_BILLING_EXPIRES_AT,
            message: t(
              "LightVela 将于 2026 年 8 月 18 日（新加坡时间）公测并计费，内测用户套餐届时将延长 1 个月。",
            ),
            href: "/docs/announcements/public-beta",
            actionLabel: t("查看详情"),
          },
        ]
      : []),
  ];
  // 默认不显示，挂载时再读 localStorage —— 避免 SSR / 首屏 flash 不一致
  const [dismissedIds, setDismissedIds] = useState<Set<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    try {
      const nextDismissedIds = new Set<string>();
      for (const id of ANNOUNCEMENT_IDS) {
        if (window.localStorage.getItem(getStorageKey(id)) === "1") {
          nextDismissedIds.add(id);
        }
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
    const remainingTimes = [
      HERMES_UPGRADE_EXPIRES_AT - now,
      GLOBAL_PUBLIC_BETA_BILLING_EXPIRES_AT - now,
    ].filter((remainingTime) => remainingTime > 0);
    if (remainingTimes.length === 0) return;
    const remaining = Math.min(...remainingTimes);
    if (remaining > MAX_SAFE_TIMEOUT_MS) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [now]);

  const visibleAnnouncements =
    dismissedIds === null
      ? []
      : announcements.filter(
          (announcement) =>
            now < announcement.expiresAt && !dismissedIds.has(announcement.id),
        );

  useEffect(() => {
    if (visibleAnnouncements.length === 0) return;
    setActiveIndex((current) =>
      current >= visibleAnnouncements.length ? 0 : current,
    );
  }, [visibleAnnouncements.length]);

  useEffect(() => {
    if (paused || visibleAnnouncements.length <= 1) return;
    const timer = setInterval(() => {
      setActiveIndex((current) => (current + 1) % visibleAnnouncements.length);
    }, CAROUSEL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [paused, visibleAnnouncements.length]);

  const visible =
    (isCN || isGlobal) &&
    pathname !== null &&
    VISIBLE_PATHS.has(stripPublicSiteLocalePrefix(pathname)) &&
    visibleAnnouncements.length > 0;

  useEffect(() => {
    document.body.classList.toggle("lw-has-announcement", visible);
    return () => {
      document.body.classList.remove("lw-has-announcement");
    };
  }, [visible]);

  const activeAnnouncement =
    visibleAnnouncements[activeIndex] ?? visibleAnnouncements[0];

  if (!visible || activeAnnouncement == null) return null;

  const showCarouselControls = visibleAnnouncements.length > 1;
  const goToPreviousAnnouncement = () => {
    setActiveIndex(
      (current) =>
        (current + visibleAnnouncements.length - 1) %
        visibleAnnouncements.length,
    );
  };
  const goToNextAnnouncement = () => {
    setActiveIndex((current) => (current + 1) % visibleAnnouncements.length);
  };
  const dismissActiveAnnouncement = () => {
    try {
      window.localStorage.setItem(getStorageKey(activeAnnouncement.id), "1");
    } catch {
      /* 写不进去也无妨，本次 session 视觉上隐藏即可 */
    }
    setDismissedIds((current) => {
      const nextDismissedIds = new Set(current ?? []);
      nextDismissedIds.add(activeAnnouncement.id);
      return nextDismissedIds;
    });
  };

  return (
    <div
      // 公告条强制 36px 单行高（h-9）。喇叭和文案打成一个 inline-flex 整体，
      // 长文案左对齐横向滚动，避免居中溢出时截掉开头；右侧用 margin
      // 给 absolute 按钮留安全区，避免文字被关闭/轮播按钮遮挡。
      className="relative flex h-9 items-center justify-center border-b border-amber-300 bg-amber-50 px-4 text-sm text-amber-950 shadow-sm"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div
        className={cn(
          "mr-8 flex min-w-0 flex-1 justify-start overflow-x-auto whitespace-nowrap",
          showCarouselControls ? "sm:mr-24" : null,
        )}
      >
        {activeAnnouncement.href ? (
          <a
            href={activeAnnouncement.href}
            className="inline-flex shrink-0 items-center gap-2 leading-9 text-amber-950 no-underline hover:underline hover:underline-offset-4"
          >
            <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
            {activeAnnouncement.message}
            {activeAnnouncement.actionLabel ? (
              <span className="font-medium">{activeAnnouncement.actionLabel}</span>
            ) : null}
          </a>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-2 leading-9">
            <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
            {activeAnnouncement.message}
          </span>
        )}
      </div>
      {showCarouselControls ? (
        <div className="absolute right-10 top-1/2 hidden -translate-y-1/2 items-center gap-1 sm:flex">
          <button
            type="button"
            aria-label={t("上一条公告")}
            onClick={goToPreviousAnnouncement}
            className="rounded p-0.5 transition-colors hover:bg-amber-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("下一条公告")}
            onClick={goToNextAnnouncement}
            className="rounded p-0.5 transition-colors hover:bg-amber-100"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={t("关闭公告")}
        onClick={dismissActiveAnnouncement}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-amber-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
