import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSession } from "@/contexts/session-context";

const GuardLoading = () => (
  <div className="flex min-h-dvh items-center justify-center bg-[var(--bg-app)] px-4 text-sm text-[var(--text-secondary)]">
    正在恢复会话...
  </div>
);

export const AuthRouteGuard = () => {
  const { authReady, isAuthenticated, planConfirmed } = useSession();

  if (!authReady) {
    return <GuardLoading />;
  }

  if (!isAuthenticated) {
    return <Outlet />;
  }

  if (!planConfirmed) {
    return <Navigate to="/plans/select" replace />;
  }

  return <Navigate to="/dashboard" replace />;
};

export const AppAccessGuard = () => {
  const location = useLocation();
  const { authReady, isAuthenticated } = useSession();

  if (!authReady) {
    return <GuardLoading />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/auth/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  return <Outlet />;
};
