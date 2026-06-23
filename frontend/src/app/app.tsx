import { RouterProvider } from "react-router-dom";
import { RepositoryProvider } from "@/contexts/repository-context";
import { RuntimeConfigProvider } from "@/contexts/runtime-config-context";
import { SessionProvider } from "@/contexts/session-context";
import { OpenClawProvider } from "@/contexts/openclaw-context";
import { router } from "@/router";
import { ThemeStyleInjector } from "@/theme/theme-style";
import { RumUserBridge } from "@/observability/rum-user-bridge";
import { ProductAnalyticsBridge } from "@/observability/product-analytics-bridge";

export const App = () => {
  return (
    <RepositoryProvider>
      <RuntimeConfigProvider>
        <SessionProvider>
          <RumUserBridge />
          <ProductAnalyticsBridge />
          <OpenClawProvider>
            <ThemeStyleInjector />
            <RouterProvider router={router} />
          </OpenClawProvider>
        </SessionProvider>
      </RuntimeConfigProvider>
    </RepositoryProvider>
  );
};
