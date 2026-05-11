import { RouterProvider } from "react-router-dom";
import { RepositoryProvider } from "@/contexts/repository-context";
import { SessionProvider } from "@/contexts/session-context";
import { OpenClawProvider } from "@/contexts/openclaw-context";
import { router } from "@/router";
import { ThemeStyleInjector } from "@/theme/theme-style";
import { RumUserBridge } from "@/observability/rum-user-bridge";

export const App = () => {
  return (
    <RepositoryProvider>
      <SessionProvider>
        <RumUserBridge />
        <OpenClawProvider>
          <ThemeStyleInjector />
          <RouterProvider router={router} />
        </OpenClawProvider>
      </SessionProvider>
    </RepositoryProvider>
  );
};
