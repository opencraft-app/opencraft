import { AnimatePresence, motion } from "framer-motion";
import { Bot, BrainCircuit, CreditCard, Files, LayoutDashboard, MessageSquare, User, LogOut, ChevronDown, ChevronRight, Globe } from "lucide-react";
import type { CSSProperties } from "react";
import { useState, useRef, useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import { InternationalLanguageMenu } from "@/components/site/language-switcher";
import { SidebarUserMenuController } from "@/components/site/sidebar-user-menu-controller";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import { useOpenClaw } from "@/contexts/agent-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { useAppNavigate, useAppSearchParams } from "@/lib/app-navigation";
import { avatarImageUrl } from "@/lib/avatar-image";
import { hasEverCreatedBot } from "@/lib/bot-creation-history";
import {
  ACCOUNT_BILLING_PATH,
  AGENTS_HOME_PATH,
  AGENT_SECTION_PATH_BY_ID,
  getAgentSectionHref,
  shouldShowWorkbenchEntry,
} from "@/lib/agent-routes";
import { shouldMoveModelEntryToAccountMenu } from "@/lib/agent-plan-navigation";
import { isGlobal } from "@/lib/region";
import {
  installConsoleShowCommand,
  subscribeConsoleShow,
} from "@/lib/console-show-event";
import { cn } from "@/lib/utils";
import { resolveAgentConsoleCollectionLabel } from "@/pages/marketing/agent-provider-locale";

type UserAvatarMenuProps = {
  showLanguageSwitcher?: boolean;
  variant?: "header" | "sidebar";
};

export const UserAvatarMenu = ({
  showLanguageSwitcher = false,
  variant = "header",
}: UserAvatarMenuProps) => variant === "sidebar"
  ? <SidebarUserMenuController showLanguageSwitcher={showLanguageSwitcher} />
  : <HeaderUserAvatarMenu showLanguageSwitcher={showLanguageSwitcher} />;

const HeaderUserAvatarMenu = ({
  showLanguageSwitcher = false,
}: Pick<UserAvatarMenuProps, "showLanguageSwitcher">) => {
  const { session, signOut } = useSession();
  const { activePass, bots, isSubscribed } = useOpenClaw();
  const t = useT();
  const { i18n } = useTranslation();
  const navigate = useAppNavigate();
  const [searchParams] = useAppSearchParams();
  const user = session.user;
  const [open, setOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [hiddenEntriesRevealed, setHiddenEntriesRevealed] = useState(false);
  const [workbenchHostname, setWorkbenchHostname] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const accountHoveredRef = useRef(false);
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

  useEffect(() => {
    const stopState = subscribeConsoleShow(setHiddenEntriesRevealed);
    const stopCommand = installConsoleShowCommand();
    return () => {
      stopState();
      stopCommand();
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
  const isSidebar = false;
  const showModelEntry = isSidebar && shouldMoveModelEntryToAccountMenu(activePass);
  const accountMenuItem = (
    <a href="/account" onClick={() => setOpen(false)} className={menuItemClass}>
      <User className={menuIconClass} />
      {t("账号")}
    </a>
  );
  const billingMenuItem = (
    <a href={ACCOUNT_BILLING_PATH} onClick={() => setOpen(false)} className={menuItemClass}>
      <CreditCard className={menuIconClass} />
      {t("套餐与费用")}
    </a>
  );
  const cloudStorageMenuItem = isSidebar ? (
    <a
      href={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.files, searchParams)}
      onClick={() => setOpen(false)}
      className={menuItemClass}
    >
      <Files className={menuIconClass} />
      {t("云存储")}
    </a>
  ) : null;

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
            onMouseLeave={() => {
              if (!isSidebar && !languageMenuOpen) setOpen(false);
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
              {/* 购买前不暴露「我的智能体」入口（PRD 2026-09-30）。
                  口径与 /agents 门禁一致：已订阅、或已有资产（有 Bot / 曾创建过）才显示，
                  否则过期老用户会在菜单里找不到入口、却能直接输 URL 进来。 */}
              {!isSidebar
                && (isSubscribed || (bots?.length ?? 0) > 0 || hasEverCreatedBot(session?.user?.id)) && (
                <a
                  href={AGENTS_HOME_PATH}
                  onClick={() => setOpen(false)}
                  className={menuItemClass}
                >
                  <Bot className={menuIconClass} />
                  {t("我的智能体")}
                </a>
              )}
              {!isSidebar && accountMenuItem}
              {showModelEntry ? (
                <a
                  href={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.model, searchParams)}
                  onClick={() => setOpen(false)}
                  className={menuItemClass}
                >
                  <BrainCircuit className={menuIconClass} />
                  {resolveAgentConsoleCollectionLabel("model", i18n.language, t)}
                </a>
              ) : null}
              {cloudStorageMenuItem}
              {billingMenuItem}
              {isSidebar && accountMenuItem}
              <a
                href={PRODUCT_FEEDBACK_URL}
                onClick={() => setOpen(false)}
                className={menuItemClass}
              >
                <MessageSquare className={menuIconClass} />
                {isGlobal ? t("用户反馈") : t("产品反馈")}
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
              {isGlobal && showLanguageSwitcher ? (
                <Popover
                  open={languageMenuOpen}
                  onOpenChange={(value) => {
                    setLanguageMenuOpen(value);
                    if (!value && !accountHoveredRef.current) setOpen(false);
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
                      if (!accountHoveredRef.current) setOpen(false);
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
