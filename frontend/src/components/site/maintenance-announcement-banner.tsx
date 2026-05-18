/**
 * 临时维护公告条（2026-05-19 02:00 CST 自动隐藏）
 *
 * 显示位置：仅 landing（"/"）和 settings（"/dashboard/settings"）页顶部。
 * 显示条件：国内站（isCN）且未到过期时刻、且用户未点击关闭。
 *
 * 关闭行为：localStorage key 带版本号，下次新公告换 ID 即可重新弹。
 *
 * 过期处理：构建期常量 EXPIRES_AT 是北京时间 2026-05-19 02:00 (UTC+8)
 * 对应的 Unix 毫秒，到期后无论 localStorage 状态都不再显示。
 */

import { Megaphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useT } from "@/i18n/t";
import { isCN } from "@/lib/region";

/** 这条公告的唯一 ID。下一次发新公告时改这个 key（例如 "0601"），让用户重新看到。 */
const ANNOUNCEMENT_ID = "0518-hermes-upgrade";

const STORAGE_KEY = `lw-announcement-dismissed:${ANNOUNCEMENT_ID}`;

/** 北京时间 2026-05-19 02:00:00 = UTC 2026-05-18 18:00:00 */
const EXPIRES_AT = Date.UTC(2026, 4 /* 0-indexed: May */, 18, 18, 0, 0);

/** 显示的路径白名单 */
const VISIBLE_PATHS = new Set<string>(["/", "/dashboard/settings"]);

export function MaintenanceAnnouncementBanner() {
  const t = useT();
  const location = useLocation();
  // 默认不显示，挂载时再读 localStorage —— 避免 SSR / 首屏 flash 不一致
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // 隐私模式 / 禁用 storage：当作未关闭，正常显示
      setDismissed(false);
    }
  }, []);

  // 国内站才显示
  if (!isCN) return null;

  // 时间过期不显示
  if (Date.now() >= EXPIRES_AT) return null;

  // 路径白名单外不显示
  if (!VISIBLE_PATHS.has(location.pathname)) return null;

  // 用户已关闭
  if (dismissed) return null;

  return (
    <div
      className="sticky top-0 z-[80] border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-7xl items-start gap-3">
        <Megaphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="flex-1 leading-relaxed">
          {t(
            "重要通知：我们将于北京时间 2026 年 5 月 19 日 0 点～2 点，对平台存量的 Hermes Agent 进行后台自动升级，升级期间可能导致你的智能体对话 / 任务执行短暂中止，带来的不便尽请谅解。",
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
          className="-mr-1 mt-0.5 shrink-0 rounded p-0.5 transition-colors hover:bg-amber-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
