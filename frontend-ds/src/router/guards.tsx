import { useState } from "react";
import { Link, Navigate, Outlet } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { LoginModal } from "@/components/site/login-modal";
import { LegalFooter } from "@/components/site/legal-footer";
import { useSession } from "@/contexts/session-context";

const GuardLoading = () => (
  <div className="flex min-h-dvh items-center justify-center bg-white px-4 text-sm text-[var(--text-secondary)]">
    正在恢复会话...
  </div>
);

export const AuthRouteGuard = () => {
  const { authReady, isAuthenticated } = useSession();

  if (!authReady) {
    return <GuardLoading />;
  }

  if (!isAuthenticated) {
    return <Outlet />;
  }

  // 已登录用户访问 /auth/* 页面时，统一跳回首页
  return <Navigate to="/" replace />;
};

export const AuthenticatedGuard = () => {
  const { authReady, isAuthenticated } = useSession();

  if (!authReady) {
    return <GuardLoading />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
};

export const AppAccessGuard = () => {
  /* Currently identical to AuthenticatedGuard.
   * Kept as a separate component so future access-control logic
   * (e.g. subscription checks) can be added here without touching
   * the generic AuthenticatedGuard. */
  return <AuthenticatedGuard />;
};

export const PlanGuard = () => {
  const { authReady, isAuthenticated, planConfirmed } = useSession();

  if (!authReady) {
    return <GuardLoading />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  if (planConfirmed) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
};

/**
 * 营销页面的登录守卫。
 * 未登录时展示品牌化的缺省页并引导用户登录（弹出 LoginModal），
 * 已登录则正常渲染子路由。
 */
export const MarketingAuthGuard = () => {
  const { authReady, isAuthenticated } = useSession();
  const [showLogin, setShowLogin] = useState(false);

  if (!authReady) {
    return <GuardLoading />;
  }

  if (isAuthenticated) {
    return <Outlet />;
  }

  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
      <main className="relative z-10 flex flex-grow items-center justify-center pb-8 pt-24">
        <div className="mx-auto flex max-w-md flex-col items-center px-6 text-center">
          {/* Logo */}
          <div
            className="flex h-20 w-20 items-center justify-center rounded-3xl"
            style={{ background: "rgba(255,255,255,0.8)", boxShadow: "0 8px 32px rgba(0,0,0,0.06)", marginBottom: 40 }}
          >
            <img
              src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png"
              alt="LightClaw"
              className="h-16 w-16 select-none object-contain pointer-events-none"
            />
          </div>
          <h2 className="text-xl font-bold" style={{ color: "#333", marginBottom: 16 }}>请先登录</h2>
          <p className="text-sm leading-relaxed" style={{ color: "#999", marginBottom: 48 }}>
            登录后即可创建和管理你的 LightClaw
          </p>
          <button
            onClick={() => setShowLogin(true)}
            className="lw-btn-primary"
          >
            立即登录
          </button>
          <Link to="/" className="lw-back-link" style={{ marginTop: 36 }}>
            <ArrowLeft className="h-3.5 w-3.5" /> 返回首页
          </Link>
        </div>
      </main>
      <LegalFooter />
      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
};
