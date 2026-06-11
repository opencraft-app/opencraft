import { LogOut } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { AGENTS_HOME_PATH } from "@/router/paths";

interface MarketingHeaderActionsProps {
  isAuthenticated: boolean;
  planConfirmed: boolean;
  displayName?: string;
  onSignOut: () => void | Promise<void>;
}

export const MarketingHeaderActions = ({
  isAuthenticated,
  planConfirmed,
  displayName,
  onSignOut,
}: MarketingHeaderActionsProps) => {
  const location = useLocation();

  if (!isAuthenticated) {
    return (
      <div className="flex items-center">
        <Button asChild>
          <Link to="/auth/sign-in">开始使用</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden max-w-[9rem] truncate rounded-full border border-[var(--border-subtle)] bg-[var(--surface-base)] px-3 py-2 text-sm text-[var(--text-secondary)] sm:block">
        {displayName ?? "已登录"}
      </div>
      <Button variant="ghost" size="sm" onClick={() => void onSignOut()} className="shrink-0">
        <LogOut className="size-4" />
        <span className="hidden sm:inline">退出</span>
      </Button>
      {planConfirmed ? (
        <Button asChild size="sm">
          <Link to={AGENTS_HOME_PATH}>进入控制台</Link>
        </Button>
      ) : location.pathname === "/plans/select" ? null : (
        <Button asChild size="sm">
          <Link to="/plans/select">继续设置</Link>
        </Button>
      )}
    </div>
  );
};
