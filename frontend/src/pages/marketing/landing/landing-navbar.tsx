import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Menu, X } from "lucide-react";
import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { BrandMark } from "@/components/site/brand-mark";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";

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
  label: string;
  href: string;
  comingSoon?: boolean;
};

const navLinks: NavLink[] = [
  { label: "概览", href: "/" },
  { label: "更新日志", href: "/changelog" },
  { label: "产品文档", href: "#", comingSoon: true },
  /* 养虾博客：暂未开张，先隐藏入口；博客上线后去掉注释即可 */
  // { label: "养虾博客", href: "#", comingSoon: true },
];

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
            const className = `inline-flex items-center gap-1.5 text-[14px] transition-colors duration-200 hover:text-black/90 ${
              active ? "font-semibold text-black/90" : "font-normal text-black/90"
            }`;
            const content = (
              <>
                {link.label}
                {link.comingSoon && (
                  <span className="inline-flex items-center justify-center w-[48px] h-[16px] rounded-tl-[4px] rounded-tr-[4px] rounded-br-[4px] rounded-bl-none bg-[#202020] text-[10px] font-normal text-white leading-none">
                    即将上线
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
              className="inline-flex items-center justify-center w-[127px] h-[36px] bg-black/90 text-white rounded-[100px] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:-translate-y-[1px] hover:shadow-lg transition-all font-heading text-sm font-medium"
            >
              立即创建
            </button>
            <button
              onClick={onLoginClick}
              className="inline-flex items-center justify-center w-[60px] h-[36px] bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-sm font-medium"
            >
              登录
            </button>
          </div>
        )}

        {/* Avatar — 已登录时只渲染一份，按当前断点决定挂载位置（桌面右侧 / 移动紧邻汉堡） */}
        {isLoggedIn && (
          <div className={`flex shrink-0 items-center ${isDesktop ? "ml-0" : "ml-auto"}`}>
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
              登录
            </button>
          )}
          <button
            className="rounded-xl p-2 transition-colors hover:bg-black/5 text-black/90"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
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
                const className = `inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm transition-all duration-250 hover:bg-black/5 ${
                  active ? "font-semibold text-black/90" : "font-normal text-black/90"
                }`;
                const content = (
                  <>
                    {link.label}
                    {link.comingSoon && (
                      <span className="inline-flex items-center justify-center w-[48px] h-[16px] rounded-tl-none rounded-bl-none rounded-tr-[4px] rounded-br-[4px] bg-[#202020] text-[10px] font-normal text-white leading-none pl-[4px]">
                        即将上线
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
                    立即创建
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
