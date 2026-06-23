import { Outlet, useNavigate } from "react-router-dom";
import { LegalFooter } from "@/components/site/legal-footer";
import { PublicSiteHeader } from "@/components/site/public-site-header";

export const MarketingLayout = () => {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <PublicSiteHeader onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="flex-1">
        <Outlet />
      </main>
      <LegalFooter />
    </div>
  );
};
