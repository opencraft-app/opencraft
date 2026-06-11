import { Outlet, useNavigate } from "react-router-dom";
import { LegalFooter } from "@/components/site/legal-footer";
import { SiteHeader } from "@/components/site/site-header";

export const MarketingLayout = () => {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <SiteHeader onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="flex-1">
        <Outlet />
      </main>
      <LegalFooter />
    </div>
  );
};
