import { AnimatePresence, motion } from "framer-motion";
import { Bot, LayoutDashboard, MessageSquare, User, LogOut, ChevronDown, ChevronRight, Globe } from "lucide-react";
import type { CSSProperties } from "react";
import { useState, useRef, useEffect, useId } from "react";
import { InternationalLanguageMenu } from "@/components/site/language-switcher";
import { SidebarUserMenuController } from "@/components/site/sidebar-user-menu-controller";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import { useOpenClaw } from "@/contexts/agent-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { useAppNavigate } from "@/lib/app-navigation";
import { avatarImageUrl } from "@/lib/avatar-image";
import { AGENTS_HOME_PATH, AGENT_SECTION_PATH_BY_ID, shouldShowWorkbenchEntry } from "@/lib/agent-routes";
import { isGlobal } from "@/lib/region";
import { registerWindowCommand } from "@/lib/window-command-chain";

type UserAvatarMenuProps = {
  showLanguageSwitcher?: boolean;
  variant?: "header" | "sidebar";
};

export const UserAvatarMenu = ({ showLanguageSwitcher = false, variant = "header" }: UserAvatarMenuProps) => variant === "sidebar"
  ? <SidebarUserMenuController showLanguageSwitcher={showLanguageSwitcher} />
  : <HeaderUserAvatarMenu showLanguageSwitcher={showLanguageSwitcher} />;

const HeaderUserAvatarMenu = ({
  showLanguageSwitcher = false,
}: Pick<UserAvatarMenuProps, "showLanguageSwitcher">) => {
  const { session, signOut } = useSession();
  const { activePass } = useOpenClaw();
  const t = useT();
  const navigate = useAppNavigate();
  const user = session.user;
  const [open, setOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [hiddenEntriesRevealed, setHiddenEntriesRevealed] = useState(false);
  const [workbenchHostname, setWorkbenchHostname] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const languageMenuOpenedByHoverRef = useRef(false);
  const languageMenuId = useId();

  /* close on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-lv-agent-language-menu="true"]')) {
        return;
      }
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setLanguageMenuOpen(false);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setWorkbenchHostname(window.location.hostname);
  }, []);

  useEffect(() => registerWindowCommand(window, "show", (next, ...args) => {
    setHiddenEntriesRevealed(true);
    const result = next(...args);
    return result === undefined ? true : result;
  }), []);

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

  return (
    <div
      ref={containerRef}
      className="relative"
    >
      {/* Avatar trigger */}
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

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className="lw-user-avatar-menu absolute z-50 overflow-hidden border border-black/[0.05] bg-white/95 right-0 top-full mt-2 w-52 origin-top-right"
            style={menuStyle}
            onMouseLeave={() => {
              if (!languageMenuOpen) setOpen(false);
            }}
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
              {!isGlobal ? (
                <a
                  href={PRODUCT_FEEDBACK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={menuItemClass}
                >
                  <MessageSquare className={menuIconClass} />
                  {t("建议反馈")}
                </a>
              ) : null}
              {isGlobal && showLanguageSwitcher ? (
                <Popover
                  open={languageMenuOpen}
                  onOpenChange={(value) => {
                    setLanguageMenuOpen(value);
                    if (!value) setOpen(false);
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={`w-full justify-between ${menuItemClass}`}
                      onMouseEnter={() => {
                        languageMenuOpenedByHoverRef.current = true;
                        setLanguageMenuOpen(true);
                      }}
                      onKeyDown={() => {
                        languageMenuOpenedByHoverRef.current = false;
                      }}
                    >
                      <span className="flex items-center gap-2.5">
                        <Globe className={menuIconClass} />
                        {t("语言")}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    data-lv-agent-language-menu="true"
                    side="right"
                    align="start"
                    sideOffset={8}
                    collisionPadding={8}
                    className="w-40 overflow-hidden border-black/[0.05] bg-white/95 p-0 sm:w-52"
                    style={menuStyle}
                    onOpenAutoFocus={(event) => {
                      if (languageMenuOpenedByHoverRef.current) event.preventDefault();
                    }}
                    onMouseLeave={() => {
                      languageMenuOpenedByHoverRef.current = false;
                      setLanguageMenuOpen(false);
                      setOpen(false);
                    }}
                  >
                    <InternationalLanguageMenu
                      id={languageMenuId}
                      ariaLabel={t("语言")}
                      reloadAfterSwitch
                    />
                  </PopoverContent>
                </Popover>
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
