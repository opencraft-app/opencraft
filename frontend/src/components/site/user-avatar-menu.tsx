import { AnimatePresence, motion } from "framer-motion";
import { Bot, LayoutDashboard, MessageSquare, User, LogOut, ChevronDown } from "lucide-react";
import type { CSSProperties } from "react";
import { useState, useRef, useEffect } from "react";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import { useOpenClaw } from "@/contexts/agent-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { useAppNavigate } from "@/lib/app-navigation";
import { avatarImageUrl } from "@/lib/avatar-image";
import { AGENTS_HOME_PATH, AGENT_SECTION_PATH_BY_ID, shouldShowWorkbenchEntry } from "@/lib/agent-routes";
import { isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

type RevealWorkbenchHost = Window & {
  show?: (...args: unknown[]) => unknown;
};

type UserAvatarMenuProps = {
  variant?: "header" | "sidebar";
};

export const UserAvatarMenu = ({ variant = "header" }: UserAvatarMenuProps) => {
  const { session, signOut } = useSession();
  const { activePass } = useOpenClaw();
  const t = useT();
  const navigate = useAppNavigate();
  const user = session.user;
  const [open, setOpen] = useState(false);
  const [hiddenEntriesRevealed, setHiddenEntriesRevealed] = useState(false);
  const [workbenchHostname, setWorkbenchHostname] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /* close on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setWorkbenchHostname(window.location.hostname);
  }, []);

  useEffect(() => {
    const host = window as RevealWorkbenchHost;
    const originalShow = host.show;
    let mounted = true;
    const revealWorkbench = (...args: unknown[]) => {
      if (mounted) {
        setHiddenEntriesRevealed(true);
      }
      if (typeof originalShow === "function") {
        const originalResult = originalShow.apply(host, args);
        return originalResult === undefined ? true : originalResult;
      }
      return true;
    };

    host.show = revealWorkbench;

    return () => {
      mounted = false;
      if (host.show !== revealWorkbench) return;
      if (originalShow === undefined) {
        delete host.show;
      } else {
        host.show = originalShow;
      }
    };
  }, []);

  const avatarSrc = avatarImageUrl(user?.avatarUrl ?? null);
  const subscriptionName = activePass?.bundle_name ?? session.currentSubscription?.code ?? null;
  const subscriptionLabel = subscriptionName ? `${t("套餐")}：${subscriptionName}` : t("未订阅");
  const menuItemClass =
    "flex items-center gap-2.5 px-4 py-2.5 text-sm font-normal text-[var(--lw-user-menu-text)] transition-colors duration-200 hover:bg-[var(--lw-user-menu-hover-bg)] hover:text-[var(--lw-user-menu-text-hover)]";
  const menuIconClass = "h-4 w-4 text-[var(--lw-user-menu-icon)]";
  const menuStyle = {
    "--lw-user-menu-text": "rgb(0 0 0 / 0.62)",
    "--lw-user-menu-text-hover": "rgb(0 0 0 / 0.88)",
    "--lw-user-menu-icon": "rgb(0 0 0 / 0.38)",
    "--lw-user-menu-hover-bg": "rgb(0 0 0 / 0.045)",
    borderRadius: "10px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
    backdropFilter: "blur(20px) saturate(160%)",
    WebkitBackdropFilter: "blur(20px) saturate(160%)",
  } as CSSProperties;
  const showWorkbenchEntry = shouldShowWorkbenchEntry({
    hostname: workbenchHostname,
    revealed: hiddenEntriesRevealed,
  });
  const isSidebar = variant === "sidebar";

  return (
    <div
      ref={containerRef}
      className={cn("relative", isSidebar && "lv-agent-account-menu")}
    >
      {/* Avatar trigger */}
      {isSidebar ? (
        <button
          type="button"
          className="lv-agent-account-trigger"
          aria-label={t("打开用户菜单")}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((value) => !value)}
        >
          <img
            src={avatarSrc}
            alt=""
            className="h-9 w-9 shrink-0 object-cover"
            style={{ border: "1.5px solid rgba(0,0,0,0.06)", borderRadius: "50%" }}
          />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold text-black/80">
              {user?.name || t("用户")}
            </span>
            <span className="block truncate text-xs text-black/40">
              {user?.email || subscriptionLabel}
            </span>
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 transition-transform duration-200"
            style={{ color: "#aaa", transform: open ? "rotate(0deg)" : "rotate(180deg)" }}
          />
        </button>
      ) : (
        <div
          onMouseEnter={() => setOpen(true)}
          className="flex items-center gap-2 rounded-full transition-all duration-200 hover:opacity-90"
        >
          <a href="/account" onClick={() => setOpen(false)} className="inline-flex shrink-0">
            <img
              src={avatarSrc}
              alt="avatar"
              className="h-9 w-9 cursor-pointer object-cover"
              style={{ border: "1.5px solid rgba(0,0,0,0.06)", borderRadius: "50%" }}
            />
          </a>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-7 w-5 items-center justify-center"
            aria-label={t("打开用户菜单")}
            aria-expanded={open}
            aria-haspopup="true"
          >
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform duration-200"
              style={{ color: "#aaa", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
        </div>
      )}

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className={cn(
              "lw-user-avatar-menu absolute z-50 overflow-hidden border border-black/[0.05] bg-white/95",
              isSidebar
                ? "bottom-full left-0 mb-2 w-[var(--lv-agents-nav-width)] origin-bottom-left"
                : "right-0 top-full mt-2 w-52 origin-top-right",
            )}
            style={menuStyle}
            onMouseLeave={() => setOpen(false)}
          >
            {/* User info */}
            <div className="border-b px-4 py-3" style={{ borderColor: "rgba(0,0,0,0.05)" }}>
              <div className="flex items-center gap-2.5">
                <img
                  src={avatarSrc}
                  alt=""
                  className="h-8 w-8 object-cover"
                  style={{ border: "1px solid rgba(0,0,0,0.05)", borderRadius: "50%" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold" style={{ color: "#333" }}>
                    {user?.name || t("用户")}
                  </p>
                  <p className="text-xs" style={{ color: "#aaa" }}>
                    {subscriptionLabel}
                  </p>
                </div>
              </div>
            </div>

            {/* Menu items */}
            <div className="py-1.5">
              <a
                href={AGENTS_HOME_PATH}
                onClick={() => setOpen(false)}
                className={menuItemClass}
              >
                <Bot className={menuIconClass} />
                {t("我的智能体伙伴")}
              </a>
              <a
                href="/account"
                onClick={() => setOpen(false)}
                className={menuItemClass}
              >
                <User className={menuIconClass} />
                {t("账号管理")}
              </a>
              {showWorkbenchEntry ? (
                <a
                  href={AGENT_SECTION_PATH_BY_ID.workbench}
                  onClick={() => setOpen(false)}
                  className={menuItemClass}
                >
                  <LayoutDashboard className={menuIconClass} />
                  {t("工作台")}
                </a>
              ) : null}
              {hiddenEntriesRevealed && !isGlobal ? (
                <a
                  href={PRODUCT_FEEDBACK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={menuItemClass}
                >
                  <MessageSquare className={menuIconClass} />
                  {t("产品反馈")}
                </a>
              ) : null}

            </div>

            {/* Logout */}
            <div className="border-t py-1.5" style={{ borderColor: "rgba(0,0,0,0.05)" }}>
              <button
                onClick={() => {
                  setOpen(false);
                  navigate("/", { replace: true });
                  void signOut();
                }}
                className={`w-full ${menuItemClass}`}
                style={{ fontSize: "14px" }}
              >
                <LogOut className={menuIconClass} />
                {t("退出登录")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
