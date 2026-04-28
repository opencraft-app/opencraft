import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Menu, X } from "lucide-react";
import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { BrandMark } from "@/components/site/brand-mark";
import { LanguageSwitcher } from "@/components/site/language-switcher";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";

/**
 * 判断当前视口是否 ≥ md 断点（768px，与 Tailwind 保持一致）。
 * 用于避免在桌面/移动两个位置同时挂载 UserAvatarMenu 导致的：
 *   1) 重复注册 document.mousedown 监听
 *   2) dropdown 状态双份运行
 * SSR 默认返回 true（桌面优先，减少首屏闪烁）。
 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 768px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}

type NavLink = {
  /** 已翻译好的导航文案 */
  label: string;
  href: string;
  comingSoon?: boolean;
};

/**
 * 生成导航链接列表。
 * 放在组件内以便 label 使用 t() 的字面量调用，让 i18n-extract 脚本能
 * 扫描到这些文案（模块级常量形态会绕过 extract 的 t(...) 正则）。
 */
function useNavLinks(): NavLink[] {
  const t = useT();
  return [
    { label: t("概览"), href: "/" },
    { label: t("更新日志"), href: "/changelog" },
    { label: t("产品文档"), href: "#", comingSoon: true },
    /* 养虾博客：暂未开张，先隐藏入口；博客上线后去掉注释即可 */
    // { label: t("博客"), href: "#", comingSoon: true },
  ];
}

/** 根据当前路径判断导航项是否高亮 */
function isLinkActive(href: string, pathname: string): boolean {
  if (href === "#") return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function LandingNavbar({
  onLoginClick,
  isLoggedIn,
}: {
  onLoginClick: () => void;
  isLoggedIn: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const t = useT();
  const navLinks = useNavLinks();

  useEffect(() => {
    setMenuOpen(false);
  }, [location]);

  return (
    <header
      className="fixed top-0 inset-x-0 z-50 border-b bg-white/90 backdrop-blur-[20px] border-black/5"
    >
      <div className="mx-auto flex items-center h-[60px] max-w-[1440px] px-6 md:px-10 lg:px-[80px]">
        {/* Logo — 统一使用 BrandMark 组件，保持跨页面视觉一致 */}
        <BrandMark to="/" />

        {/* Desktop Nav — centered */}
        <nav className="hidden flex-1 items-center justify-center gap-6 md:flex">
          {navLinks.map((link) => {
            const active = isLinkActive(link.href, location.pathname);
            const { label } = link;
            const className = `inline-flex items-center gap-1.5 text-[14px] transition-colors duration-200 hover:text-black/90 ${
              active ? "font-semibold text-black/90" : "font-normal text-black/90"
            }`;
            const content = (
              <>
                {label}
                {link.comingSoon && (
                  /* 自适应宽度：中文「即将上线」≈48px，英文「Coming soon」更长，
                   * 用 px-1.5 + whitespace-nowrap 让徽章不会被截断换行。 */
                  <span className="inline-flex items-center justify-center h-[16px] px-1.5 whitespace-nowrap rounded-tl-[4px] rounded-tr-[4px] rounded-br-[4px] rounded-bl-none bg-[#202020] text-[10px] font-normal text-white leading-none">
                    {t("即将上线")}
                  </span>
                )}
              </>
            );
            // coming soon 占位（href="#"）仍用 a，防止被路由拦截
            if (link.href === "#") {
              return (
                <a key={link.label} href={link.href} className={className}>
                  {content}
                </a>
              );
            }
            return (
              <Link key={link.label} to={link.href} className={className}>
                {content}
              </Link>
            );
          })}
        </nav>

        {/* Desktop CTA — 仅桌面且未登录时显示 */}
        {!isLoggedIn && (
          <div className="hidden shrink-0 items-center gap-3 md:flex">
            <button
              onClick={onLoginClick}
              className="inline-flex items-center justify-center h-[36px] px-5 bg-black/90 text-white rounded-[100px] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:-translate-y-[1px] hover:shadow-lg transition-all font-heading text-sm font-medium whitespace-nowrap"
            >
              {t("立即创建")}
            </button>
            <button
              onClick={onLoginClick}
              className="inline-flex items-center justify-center h-[36px] px-4 bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-sm font-medium whitespace-nowrap"
            >
              {t("登录")}
            </button>
            {/* 语言切换器：仅国际站展示，国内站无需多语言入口 */}
            {isGlobal && <LanguageSwitcher />}
          </div>
        )}

        {/* Avatar — 已登录时只渲染一份，按当前断点决定挂载位置（桌面右侧 / 移动紧邻汉堡） */}
        {isLoggedIn && (
          <div className={`flex shrink-0 items-center gap-3 ${isDesktop ? "ml-0" : "ml-auto"}`}>
            {/* 已登录态下桌面端同样保留语言切换入口 */}
            {isGlobal && isDesktop && <LanguageSwitcher />}
            <UserAvatarMenu />
          </div>
        )}

        {/* Mobile Right — 未登录的登录按钮 + 汉堡（已登录时仅渲染汉堡） */}
        <div className={`flex items-center gap-2 md:hidden ${isLoggedIn ? "" : "ml-auto"}`}>
          {!isLoggedIn && (
            <button
              onClick={onLoginClick}
              className="inline-flex items-center justify-center h-[32px] px-3 bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-[13px] font-medium"
            >
              {t("登录")}
            </button>
          )}
          <button
            className="rounded-xl p-2 transition-colors hover:bg-black/5 text-black/90"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? t("关闭菜单") : t("打开菜单")}
          >
            {menuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute left-0 right-0 top-full border-b shadow-lg md:hidden border-black/5 bg-white/95 backdrop-blur-[20px]"
          >
            <div className="mx-auto flex flex-col gap-2 px-6 py-4 max-w-[1440px]">
              {navLinks.map((link) => {
                const active = isLinkActive(link.href, location.pathname);
                const { label } = link;
                const className = `inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm transition-all duration-250 hover:bg-black/5 ${
                  active ? "font-semibold text-black/90" : "font-normal text-black/90"
                }`;
                const content = (
                  <>
                    {label}
                    {link.comingSoon && (
                      /* 自适应宽度：避免英文「Coming soon」被截断 */
                      <span className="inline-flex items-center justify-center h-[16px] px-1.5 whitespace-nowrap rounded-tl-none rounded-bl-none rounded-tr-[4px] rounded-br-[4px] bg-[#202020] text-[10px] font-normal text-white leading-none">
                        {t("即将上线")}
                      </span>
                    )}
                  </>
                );
                if (link.href === "#") {
                  return (
                    <a
                      key={link.label}
                      href={link.href}
                      className={className}
                      onClick={() => setMenuOpen(false)}
                    >
                      {content}
                    </a>
                  );
                }
                return (
                  <Link
                    key={link.label}
                    to={link.href}
                    className={className}
                    onClick={() => setMenuOpen(false)}
                  >
                    {content}
                  </Link>
                );
              })}
              {/* 未登录：汉堡菜单内保留「立即创建」CTA；已登录：头像菜单已承载设置入口，这里不再重复 */}
              {!isLoggedIn && (
                <div className="border-t border-black/5 pt-3">
                  <button
                    onClick={() => { setMenuOpen(false); onLoginClick(); }}
                    className="inline-flex items-center justify-center gap-2 w-full bg-black/90 text-white px-5 py-3 rounded-full font-medium text-[14px] cursor-pointer"
                  >
                    {t("立即创建")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* 移动端：语言切换器平铺在菜单底部，仅国际站展示 */}
              {isGlobal && (
                <div className="border-t border-black/5 pt-3">
                  <LanguageSwitcher variant="inline" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
