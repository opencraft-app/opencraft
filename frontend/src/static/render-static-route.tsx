import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import "@/i18n";
import { HeaderSectionContent } from "@/imports/Frame2147230025/sections/HeaderSection";
import HeroSection from "@/imports/Frame2147230025/sections/HeroSection";
import "@/pages/marketing/landing-page-isolation.css";

type StaticRouteInput = {
  route: {
    kind: string;
    path: string;
  };
};

const noop = () => undefined;

function StaticLandingPage() {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <div className="lw-landing-root w-full bg-white overflow-x-hidden">
        <div className="relative">
          <HeaderSectionContent
            onLoginClick={noop}
            onCreateClick={noop}
            authSnapshot={{ authReady: false, isAuthenticated: false }}
          />
          <HeroSection onCreateClick={noop} />
        </div>
      </div>
    </MemoryRouter>
  );
}

export function renderStaticRoute({ route }: StaticRouteInput): string | null {
  if (route.kind !== "home") return null;
  return renderToString(<StaticLandingPage />);
}
