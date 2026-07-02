/**
 * LightVela 公测公告条（北京时间 2026-08-16 00:00 自动撤下）
 *
 * 显示位置：仅 landing（"/"）页顶部。
 * 显示条件：国内站首页且未到撤下时刻、且用户未点击关闭。
 * 布局方式：普通文档流顶部条，出现时把首页整体向下推，避免覆盖首屏内容。
 *
 * 关闭行为：localStorage key 带版本号，下次新公告换 ID 即可重新弹。
 *
 * 过期处理：构建期常量 EXPIRES_AT 是北京时间 2026-08-16 00:00 (UTC+8)
 * 对应的 Unix 毫秒，到期后无论 localStorage 状态都不再显示。
 */

import { Megaphone, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/i18n/t";
import { stripPublicSiteLocalePrefix } from "@/lib/public-site-routing";
import { isCN } from "@/lib/region";

/** 这条公告的唯一 ID。下一次发新公告时改这个 key（例如 "0601"），让用户重新看到。 */
const ANNOUNCEMENT_ID = "0730-public-beta-preview-v2";

const STORAGE_KEY = `lw-announcement-dismissed:${ANNOUNCEMENT_ID}`;

/** 北京时间 2026-08-16 00:00:00 = UTC 2026-08-15 16:00:00 */
const EXPIRES_AT = Date.UTC(2026, 7 /* 0-indexed: August */, 15, 16, 0, 0);
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

/** 显示的路径白名单。国际站会先剥离 /en-us、/zh-cn、/zh-sg 等语言前缀。 */
const VISIBLE_PATHS = new Set<string>(["/"]);

const ANNOUNCEMENT_HREF = "/docs/announcements/public-beta";

/** 公告条占据的页面高度（px）。 */
export const ANNOUNCEMENT_BANNER_HEIGHT_PX = 36;

export function MaintenanceAnnouncementBanner() {
  const t = useT();
  const pathname = usePathname();
  const message = t("LightVela 预计将于 2026 年 7 月 15 日正式开启公测，内测用户将享受 1 个月延期权益。");
  // 默认不显示，挂载时再读 localStorage —— 避免 SSR / 首屏 flash 不一致
  const [dismissed, setDismissed] = useState(true);
  /** 组件挂载后同步刷新一次"是否已过期"，并在到期时刻 setTimeout 强制隐藏 */
  const [expired, setExpired] = useState(() => Date.now() >= EXPIRES_AT);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // 隐私模式 / 禁用 storage：当作未关闭，正常显示
      setDismissed(false);
    }
  }, []);

  // 用户挂着浏览器跨过撤下时间的场景：不依赖刷新 / 切路由，到点强制隐藏。
  // setTimeout 上限约 24 天；距离过期太久时跳过定时器，后续访问会重新计算过期状态。
  useEffect(() => {
    const remaining = EXPIRES_AT - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    if (remaining > MAX_SAFE_TIMEOUT_MS) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, []);

  const visible =
    isCN &&
    pathname !== null &&
    !expired &&
    VISIBLE_PATHS.has(stripPublicSiteLocalePrefix(pathname)) &&
    !dismissed;

  if (!visible) return null;

  return (
    <div
      // 公告条强制 36px 单行高（h-9）。喇叭和文案打成一个 inline-flex 整体，
      // 在 flex-1 容器里居中。X 按钮 absolute 脱离居中流，链接上 pr-8 安全
      // padding 避免长文字撞到 X。窄屏文案放不下时整组横向滚动看完。
      className="relative flex h-9 items-center justify-center border-b border-amber-300 bg-amber-50 px-4 text-sm text-amber-950 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-1 justify-center overflow-x-auto whitespace-nowrap">
        <a
          href={ANNOUNCEMENT_HREF}
          className="inline-flex items-center gap-2 pr-8 leading-9 text-amber-950 no-underline hover:underline hover:underline-offset-4"
        >
          <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
          {message}
          <span className="font-medium">{t("查看详情")}</span>
        </a>
      </div>
      <button
        type="button"
        aria-label={t("关闭公告")}
        onClick={() => {
          try {
            window.localStorage.setItem(STORAGE_KEY, "1");
          } catch {
            /* 写不进去也无妨，本次 session 视觉上隐藏即可 */
          }
          setDismissed(true);
        }}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-amber-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
