import { Outlet } from "react-router-dom";
import { ImpersonationBanner } from "@/components/site/impersonation-banner";

export const AppShellLayout = () => {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <ImpersonationBanner />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};
