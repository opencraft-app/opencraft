import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Menu, X } from "lucide-react";
import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { LOGO_URL } from "./constants";

const navLinks = [
  { label: "概览", href: "/", active: true },
  { label: "更新日志", href: "/changelog" },
  { label: "产品文档", href: "#", comingSoon: true },
  { label: "养虾博客", href: "#", comingSoon: true },
];

export function LandingNavbar({
  onLoginClick,
  isLoggedIn,
}: {
  onLoginClick: () => void;
  isLoggedIn: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location]);

  return (
    <header
      className="fixed top-0 inset-x-0 z-50 border-b bg-white/90 backdrop-blur-[20px] border-black/5"
    >
      <div className="mx-auto flex items-center h-[60px] max-w-[1440px] px-[80px] max-md:px-6">
        {/* Logo */}
        <Link to="/" className="flex shrink-0 items-center">
          <img
            src={LOGO_URL}
            alt="LightClaw"
            className="object-contain h-[32px]"
          />
        </Link>

        {/* Desktop Nav — centered */}
        <nav className="hidden flex-1 items-center justify-center gap-6 md:flex">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className={`inline-flex items-center gap-1.5 text-[14px] transition-colors duration-200 hover:text-black/90 ${
                link.active
                  ? "font-semibold text-black/90"
                  : "font-normal text-black/90"
              }`}
            >
              {link.label}
              {link.comingSoon && (
                <span className="inline-flex items-center justify-center w-[48px] h-[16px] rounded-tl-[4px] rounded-tr-[4px] rounded-br-[4px] rounded-bl-none bg-[#202020] text-[10px] font-normal text-white leading-none">
                  即将上线
                </span>
              )}
            </a>
          ))}
        </nav>

        {/* CTA / Avatar */}
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          {isLoggedIn ? (
            <UserAvatarMenu />
          ) : (
            <>
              <button
                onClick={onLoginClick}
                className="inline-flex items-center justify-center w-[127px] h-[36px] bg-black/90 text-white rounded-[100px] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:-translate-y-[1px] hover:shadow-lg transition-all font-heading text-sm font-medium"
              >
                创建LightClaw
              </button>
              <button
                onClick={onLoginClick}
                className="inline-flex items-center justify-center w-[60px] h-[36px] bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-sm font-medium"
              >
                登录
              </button>
            </>
          )}
        </div>

        {/* Mobile Toggle */}
        <button
          className="ml-auto rounded-xl p-2 transition-colors hover:bg-black/5 md:hidden text-black/90"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
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
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm transition-all duration-250 hover:bg-black/5 ${
                    link.active ? "font-semibold text-black/90" : "font-normal text-black/90"
                  }`}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                  {link.comingSoon && (
                    <span className="inline-flex items-center justify-center w-[48px] h-[16px] rounded-tl-none rounded-bl-none rounded-tr-[4px] rounded-br-[4px] bg-[#202020] text-[10px] font-normal text-white leading-none pl-[4px]">
                      即将上线
                    </span>
                  )}
                </a>
              ))}
              <div className="border-t border-black/5 pt-3">
                {isLoggedIn ? (
                  <Link
                    to="/openclaw/settings"
                    className="flex w-full items-center gap-2 rounded-full px-4 py-3 text-sm font-semibold text-black/90 transition-all duration-250 hover:bg-black/5"
                  >
                    设置中心
                  </Link>
                ) : (
                  <button
                    onClick={() => { setMenuOpen(false); onLoginClick(); }}
                    className="inline-flex items-center justify-center gap-2 w-full bg-black/90 text-white px-5 py-3 rounded-full font-medium text-[14px] cursor-pointer"
                  >
                    立即创建
                    <ArrowRight className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
