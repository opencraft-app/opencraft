import { Outlet, useNavigate } from "react-router-dom";
import { LegalFooter } from "@/components/site/legal-footer";
import { SiteHeader } from "@/components/site/site-header";
import { useSession } from "@/contexts/session-context";

export const MarketingLayout = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useSession();

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <SiteHeader isLoggedIn={isAuthenticated} onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="flex-1">
        <Outlet />
      </main>
      <LegalFooter />
    </div>
  );
};
