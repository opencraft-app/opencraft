import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShellLayout } from "@/layouts/app-shell-layout";
import { MarketingLayout } from "@/layouts/marketing-layout";
import { InvitePage } from "@/pages/auth/invite-page";
import { SignInPage } from "@/pages/auth/sign-in-page";
import { SignUpPage } from "@/pages/auth/sign-up-page";
import { AccountProfilePage } from "@/pages/app/account-profile-page";
import { BotTerminalPage } from "@/pages/app/bot-terminal-page";
import { PlanSelectPage } from "@/pages/app/plan-select-page";
import { SettingsPage } from "@/pages/app/settings-page";
import { StyleLabPage } from "@/pages/app/style-lab-page";
import { WorkspacePage } from "@/pages/app/workspace-page";
import { LandingPage } from "@/pages/marketing/landing-page";
import { SubscribePage } from "@/pages/marketing/subscribe-page";
import { OpenClawSetupPage } from "@/pages/marketing/openclaw-setup-page";
import { OpenClawSuccessPage } from "@/pages/marketing/openclaw-success-page";
import { OpenClawSettingsPage } from "@/pages/marketing/openclaw-settings-page";
import { AccountPage } from "@/pages/marketing/account-page";
import { AccountOrdersPage } from "@/pages/marketing/account-orders-page";
import { ChangelogPage } from "@/pages/marketing/changelog-page";

const NotFoundPage = () => (
  <div className="mx-auto max-w-2xl px-4 py-20 text-center">
    <h1 className="font-display-zh text-3xl font-semibold">页面不存在</h1>
    <p className="mt-2 text-[var(--text-secondary)]">你访问的地址不在当前原型路由中。</p>
  </div>
);

export const router = createBrowserRouter([
  {
    path: "/",
    children: [
      {
        index: true,
        element: <LandingPage />,
      },
      {
        path: "changelog",
        element: <ChangelogPage />,
      },
      {
        path: "subscribe",
        element: <SubscribePage />,
      },
      {
        path: "openclaw/success",
        element: <OpenClawSuccessPage />,
      },
      {
        path: "openclaw/setup",
        element: <OpenClawSetupPage />,
      },
      {
        path: "openclaw/settings",
        element: <OpenClawSettingsPage />,
      },
      {
        path: "account",
        element: <AccountPage />,
      },
      {
        path: "account/orders",
        element: <AccountOrdersPage />,
      },
      {
        element: <MarketingLayout />,
        children: [
          {
            path: "auth/sign-in",
            element: <SignInPage />,
          },
          {
            path: "auth/sign-up",
            element: <SignUpPage />,
          },
          {
            path: "auth/sign-up-code",
            element: <Navigate to="/auth/sign-in" replace />,
          },
          {
            path: "auth/invite",
            element: <InvitePage />,
          },
          {
            path: "auth/forgot-password",
            element: <Navigate to="/auth/sign-in" replace />,
          },
          {
            path: "plans/select",
            element: <PlanSelectPage />,
          },
        ],
      },
    ],
  },
  {
    element: <AppShellLayout />,
    children: [
      {
        path: "/settings/account",
        element: <AccountProfilePage />,
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
      {
        path: "*",
        element: <Navigate to="/openclaw/settings" replace />,
      },
    ],
  },
  {
    path: "/internal/style-lab",
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
    element: <NotFoundPage />,
  },
]);
