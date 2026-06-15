import { SiteHeader } from "@/components/site/site-header";

export function LandingNavbar({
  onLoginClick,
}: {
  onLoginClick: () => void;
}) {
  return <SiteHeader fixed onLoginClick={onLoginClick} />;
}
