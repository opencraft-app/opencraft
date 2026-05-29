/**
 * 临时维护公告条（北京时间 2026-05-25 06:00 自动撤下）
 *
 * 显示位置：仅 landing（"/"）和 settings（"/dashboard/settings"）页顶部。
 * 显示条件：国内站（isCN）且未到撤下时刻、且用户未点击关闭。
 *
 * 关闭行为：localStorage key 带版本号，下次新公告换 ID 即可重新弹。
 *
 * 过期处理：构建期常量 EXPIRES_AT 是北京时间 2026-05-25 06:00 (UTC+8)
 * 对应的 Unix 毫秒，到期后无论 localStorage 状态都不再显示。
 *
 * 注意：升级窗口是 23:00-次日 03:00，公告撤下时间是 06:00，留 3 小时缓冲让
 * 错过升级窗口刚醒来的用户也能看到说明。
 */

import { Megaphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useT } from "@/i18n/t";
import { isCN } from "@/lib/region";

/** 这条公告的唯一 ID。下一次发新公告时改这个 key（例如 "0601"），让用户重新看到。 */
const ANNOUNCEMENT_ID = "0524-hermes-upgrade";

const STORAGE_KEY = `lw-announcement-dismissed:${ANNOUNCEMENT_ID}`;

/** 北京时间 2026-05-25 06:00:00 = UTC 2026-05-24 22:00:00 */
const EXPIRES_AT = Date.UTC(2026, 4 /* 0-indexed: May */, 24, 22, 0, 0);

/** 显示的路径白名单 */
const VISIBLE_PATHS = new Set<string>(["/", "/dashboard/settings"]);

/** 公告条占据的 viewport 高度（px）。同步给 LandingNavbar / SettingsNavbar /
 * HeroSection 留位时使用，硬编码而非测量，避免布局抖动。 */
export const ANNOUNCEMENT_BANNER_HEIGHT_PX = 36;

/**
 * 给 <body> 设 `lw-has-announcement` class —— 全局 CSS 据此把
 * 下方的 fixed navbar / hero padding 偏移 ANNOUNCEMENT_BANNER_HEIGHT_PX。
 * 这样 navbar / hero 不需要 import 公告组件、也不需要 React state 联动。
 */
function useBodyAnnouncementClass(visible: boolean) {
  useEffect(() => {
    if (!visible) return;
    document.body.classList.add("lw-has-announcement");
    return () => {
      document.body.classList.remove("lw-has-announcement");
    };
  }, [visible]);
}

export function MaintenanceAnnouncementBanner() {
  const t = useT();
  const location = useLocation();
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

  // 用户挂着浏览器跨过 06:00 的场景：不依赖刷新 / 切路由，到点强制隐藏。
  // setTimeout 上限 ~24 天（i32 ms），公告窗口最多几小时所以稳。
  useEffect(() => {
    const remaining = EXPIRES_AT - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, []);

  // 把"是否实际渲染"汇成一个布尔，方便 useBodyAnnouncementClass 跟随
  const visible =
    isCN &&
    !expired &&
    VISIBLE_PATHS.has(location.pathname) &&
    !dismissed;

  useBodyAnnouncementClass(visible);

  if (!visible) return null;

  return (
    <div
      // 公告条强制 36px 单行高（h-9）。喇叭和文案打成一个 inline-flex 整体，
      // 在 flex-1 容器里居中。X 按钮 absolute 脱离居中流，<p> 上 pr-8 安全
      // padding 避免长文字撞到 X。窄屏文案放不下时整组横向滚动看完。
      className="fixed inset-x-0 top-0 z-[60] flex h-9 items-center justify-center border-b border-amber-300 bg-amber-50 px-4 text-sm text-amber-950 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-1 justify-center overflow-x-auto whitespace-nowrap">
        <span className="inline-flex items-center gap-2 pr-8 leading-9">
          <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t(
            "通知：我们将于北京时间2026年5月24日23点～25日凌晨3点，对存量的 Hermes Agent 版本进行后台自动升级，升级期间可能导致智能体对话或任务执行短暂中止，带来不便尽请谅解。",
          )}
        </span>
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
