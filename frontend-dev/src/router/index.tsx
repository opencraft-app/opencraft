import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShellLayout } from "@/layouts/app-shell-layout";
import { SignInPage } from "@/pages/auth/sign-in-page";
import { AccountProfilePage } from "@/pages/account-profile-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { BotTerminalPage } from "@/pages/bot-terminal-page";
import { PlanSelectPage } from "@/pages/plan-select-page";
import { SettingsPage } from "@/pages/settings-page";
import { StyleLabPage } from "@/pages/style-lab-page";
import { WorkspacePage } from "@/pages/workspace-page";
import { AppAccessGuard, AuthRouteGuard } from "@/router/guards";

export const router = createBrowserRouter([
  {
    element: <AuthRouteGuard />,
    children: [
      {
        path: "/auth/sign-in",
        element: <SignInPage />,
      },
      {
        path: "/auth/sign-up",
        element: <Navigate to="/auth/sign-in" replace />,
      },
    ],
  },
  {
    element: <AppAccessGuard />,
    children: [
      {
        element: <AppShellLayout />,
        children: [
          {
            index: true,
            element: <Navigate to="/dashboard" replace />,
          },
          {
            path: "/dashboard",
            element: <DashboardPage />,
          },
          {
            path: "/settings/account",
            element: <AccountProfilePage />,
          },
          {
            path: "/plans/select",
            element: <PlanSelectPage />,
          },
          {
            path: "/bots/:id/workspace",
            element: <WorkspacePage />,
          },
          {
            path: "/bots/:id/settings",
            element: <SettingsPage />,
          },
          {
            path: "/bots/:id/terminal",
            element: <BotTerminalPage />,
          },
        ],
      },
    ],
  },
  {
    path: "/internal/style-lab",
    element: <AppAccessGuard />,
    children: [
      {
        element: <AppShellLayout />,
        children: [
          {
            index: true,
            element: <StyleLabPage />,
          },
        ],
      },
    ],
  },
  {
    path: "*",
    element: (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="font-display-zh text-3xl font-semibold">页面不存在</h1>
        <p className="mt-2 text-[var(--text-secondary)]">你访问的地址不在当前开发测试路由中。</p>
      </div>
    ),
  },
]);
