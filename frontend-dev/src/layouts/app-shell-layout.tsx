import { LogOut } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { BrandMark } from "@/components/site/brand-mark";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/session-context";
import { cn } from "@/lib/utils";

const appNavItems: Array<{ to: string; label: string; requiresBot?: boolean }> = [
  { to: "/dashboard", label: "总览" },
  { to: "/settings/account", label: "账号" },
  { to: "/bots/default/workspace", label: "工作台", requiresBot: true },
  { to: "/bots/default/settings", label: "设置", requiresBot: true },
];

export const AppShellLayout = () => {
  const { session, signOut } = useSession();
  const botId = session.firstBotId;

  const navItems = appNavItems.map((item) => {
    if (item.requiresBot && !botId) {
      return { ...item, to: "/dashboard", disabled: true };
    }

    return { ...item, to: item.to.replace("default", botId ?? ""), disabled: false };
  });

  return (
    <div className="landing-page min-h-dvh" style={{ background: "var(--lw-bg)", color: "var(--lw-fg)", fontFamily: '"Source Sans 3","Noto Sans SC",sans-serif' }}>
      <header className="sticky top-0 z-20 border-b backdrop-blur-lg" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.86)" }}>
        <div className="mx-auto flex min-h-[4.75rem] w-full max-w-[var(--lw-max-content)] items-center justify-between gap-3 px-4 sm:px-6">
          <BrandMark to="/dashboard" labelClassName="text-[var(--lw-fg)]" />

          <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto px-1">
            {navItems.map((item) => (
              <NavLink
                key={`${item.label}_${item.to}`}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-all",
                    item.disabled && "pointer-events-none opacity-45",
                    isActive
                      ? "shadow-sm"
                      : "",
                  )
                }
                style={({ isActive }) => ({
                  background: isActive ? "var(--lw-bg-secondary)" : "transparent",
                  color: isActive ? "var(--lw-fg)" : "var(--lw-fg-secondary)",
                  border: `1px solid ${isActive ? "var(--lw-border)" : "transparent"}`,
                })}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden max-w-[11rem] truncate rounded-full border px-3 py-2 text-sm sm:block" style={{ borderColor: "var(--lw-border)", background: "rgba(250,250,248,0.92)", color: "var(--lw-fg-secondary)" }}>
              {session.user?.name ?? "已登录"}
            </div>
            <Button variant="ghost" size="sm" onClick={() => void signOut()} className="shrink-0 rounded-full" style={{ color: "var(--lw-fg-secondary)" }}>
              <LogOut className="size-4" />
              <span className="hidden sm:inline">退出</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[var(--lw-max-content)] px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
};
