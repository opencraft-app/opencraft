/**
 * 临时维护公告条（北京时间 2026-05-19 06:00 自动撤下）
 *
 * 显示位置：仅 landing（"/"）和 settings（"/dashboard/settings"）页顶部。
 * 显示条件：国内站（isCN）且未到撤下时刻、且用户未点击关闭。
 *
 * 关闭行为：localStorage key 带版本号，下次新公告换 ID 即可重新弹。
 *
 * 过期处理：构建期常量 EXPIRES_AT 是北京时间 2026-05-19 06:00 (UTC+8)
 * 对应的 Unix 毫秒，到期后无论 localStorage 状态都不再显示。
 *
 * 注意：升级窗口是 0:00-3:00，公告撤下时间是 06:00，留 3 小时缓冲让
 * 错过升级窗口刚醒来的用户也能看到说明。
 */

import { Megaphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useT } from "@/i18n/t";
import { isCN } from "@/lib/region";

/** 这条公告的唯一 ID。下一次发新公告时改这个 key（例如 "0601"），让用户重新看到。 */
const ANNOUNCEMENT_ID = "0518-hermes-upgrade";

const STORAGE_KEY = `lw-announcement-dismissed:${ANNOUNCEMENT_ID}`;

/** 北京时间 2026-05-19 06:00:00 = UTC 2026-05-18 22:00:00 */
const EXPIRES_AT = Date.UTC(2026, 4 /* 0-indexed: May */, 18, 22, 0, 0);

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
      // 高度由 ANNOUNCEMENT_BANNER_HEIGHT_PX (= 36px) 决定 —— 用 min-h 而不是
      // 固定 h-9，是为了在窄屏文案折行时允许公告条增高，不被裁断。
      // navbar / hero 的偏移按 36px 写死的好处：绝大多数情况单行不增高，
      // 只有窄屏多行才会与 navbar 留出小重叠（仍可读，可接受的退化）。
      className="fixed inset-x-0 top-0 z-[60] flex min-h-9 items-center border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-sm text-amber-950 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3">
        <Megaphone className="h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="flex-1 leading-relaxed">
          {t(
            "重要通知：我们将于北京时间 2026 年 5 月 19 日 0 点～3 点，对平台存量的 Hermes Agent 版本进行后台自动升级，升级期间可能导致智能体对话或任务执行短暂中止，带来的不便尽请谅解。",
          )}
        </p>
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
          className="-mr-1 shrink-0 rounded p-0.5 transition-colors hover:bg-amber-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
