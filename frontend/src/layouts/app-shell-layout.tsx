import { Outlet, useNavigate } from "react-router-dom";
import { PublicSiteHeader } from "@/components/site/public-site-header";
import { useRouteSeoMeta } from "@/lib/seo";

export const AppShellLayout = () => {
  const navigate = useNavigate();
  useRouteSeoMeta();

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <PublicSiteHeader onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};
