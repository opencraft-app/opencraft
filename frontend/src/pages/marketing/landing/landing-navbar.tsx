import { SiteHeader } from "@/components/site/site-header";

export function LandingNavbar({
  onLoginClick,
  isLoggedIn,
}: {
  onLoginClick: () => void;
  isLoggedIn: boolean;
}) {
  return <SiteHeader fixed isLoggedIn={isLoggedIn} onLoginClick={onLoginClick} />;
}
