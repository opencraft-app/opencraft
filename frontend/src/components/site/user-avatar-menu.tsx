import { AnimatePresence, motion } from "framer-motion";
import { Bot, User, LogOut, ChevronDown } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { avatarImageUrl } from "@/lib/avatar-image";

export const UserAvatarMenu = () => {
  const { session, signOut } = useSession();
  const { activePass } = useOpenClaw();
  const navigate = useNavigate();
  const t = useT();
  const user = session.user;
  const [open, setOpen] = useState(false);
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

  const avatarSrc = avatarImageUrl(user?.avatarUrl ?? null);
  const subscriptionName = activePass?.bundle_name ?? session.currentSubscription?.code ?? null;
  const subscriptionLabel = subscriptionName ? `${t("套餐")} ${subscriptionName}` : t("未订阅");

  return (
    <div ref={containerRef} className="relative">
      {/* Avatar trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full transition-all duration-200 hover:opacity-90"
      >
        <img
          src={avatarSrc}
          alt="avatar"
          className="h-9 w-9 cursor-pointer object-cover"
          style={{ border: "1.5px solid rgba(0,0,0,0.06)", borderRadius: "50%" }}
          onClick={(e) => { e.stopPropagation(); navigate("/account"); }}
        />
        <ChevronDown
          className="h-3.5 w-3.5 transition-transform duration-200"
          style={{ color: "#aaa", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden border border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--surface-base)_96%,white)]"
            style={{
              borderRadius: "10px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
              backdropFilter: "blur(20px) saturate(160%)",
              WebkitBackdropFilter: "blur(20px) saturate(160%)",
            }}
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
              <Link
                to="/dashboard/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-normal text-[var(--text-secondary)] transition-all duration-250 hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
              >
                <Bot className="h-4 w-4 text-[var(--text-tertiary)]" />
                {t("我的智能体伙伴")}
              </Link>
              <Link
                to="/account"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-normal text-[var(--text-secondary)] transition-all duration-250 hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
              >
                <User className="h-4 w-4 text-[var(--text-tertiary)]" />
                {t("账号管理")}
              </Link>
            </div>

            {/* Logout */}
            <div className="border-t py-1.5" style={{ borderColor: "rgba(0,0,0,0.05)" }}>
              <button
                onClick={() => {
                  void signOut();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-normal text-[var(--text-secondary)] transition-all duration-250 hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                style={{ fontSize: "14px" }}
              >
                <LogOut className="h-4 w-4 text-[var(--text-tertiary)]" />
                {t("退出登录")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
