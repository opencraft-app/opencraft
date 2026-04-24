import { RouterProvider } from "react-router-dom";
import { RepositoryProvider } from "@/contexts/repository-context";
import { SessionProvider } from "@/contexts/session-context";
import { router } from "@/router";
import { ThemeStyleInjector } from "@/theme/theme-style";

export const App = () => {
  return (
    <RepositoryProvider>
      <SessionProvider>
        <ThemeStyleInjector />
        <RouterProvider router={router} />
      </SessionProvider>
    </RepositoryProvider>
  );
};
