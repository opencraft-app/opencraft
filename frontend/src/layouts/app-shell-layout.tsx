import { Outlet, useNavigate } from "react-router-dom";
import { SiteHeader } from "@/components/site/site-header";
import { useRouteSeoMeta } from "@/lib/seo";

export const AppShellLayout = () => {
  const navigate = useNavigate();
  useRouteSeoMeta();

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <SiteHeader onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};
