import { Outlet } from "react-router-dom";
import { BrandMark } from "@/components/site/brand-mark";
import { LegalFooter } from "@/components/site/legal-footer";
import { MarketingHeaderActions } from "@/components/site/marketing-header-actions";
import { useSession } from "@/contexts/session-context";

export const MarketingLayout = () => {
  const { isAuthenticated, planConfirmed, session, signOut } = useSession();

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-white/88 backdrop-blur-lg">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <BrandMark to="/" labelClassName="text-base" />
          <MarketingHeaderActions
            isAuthenticated={isAuthenticated}
            planConfirmed={planConfirmed}
            displayName={session.user?.name}
            onSignOut={signOut}
          />
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <LegalFooter />
    </div>
  );
};
