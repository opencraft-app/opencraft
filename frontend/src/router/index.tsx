import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShellLayout } from "@/layouts/app-shell-layout";
import { MarketingLayout } from "@/layouts/marketing-layout";
import { RootLayout } from "@/layouts/root-layout";
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
import { CreateOpenClawPage } from "@/pages/marketing/create-openclaw-page";
import { SubscribePage } from "@/pages/marketing/subscribe-page";
import { OpenClawSetupPage } from "@/pages/marketing/openclaw-setup-page";
import { OpenClawSuccessPage } from "@/pages/marketing/openclaw-success-page";
import { OpenClawSettingsPage } from "@/pages/marketing/openclaw-settings-page";
import { AccountPage } from "@/pages/marketing/account-page";
import { AccountOrdersPage } from "@/pages/marketing/account-orders-page";
import { ChangelogPage } from "@/pages/marketing/changelog-page";
import { DocsPage } from "@/pages/docs/docs-page";
import { DocsLayout } from "@/components/docs/docs-layout";
import { AppAccessGuard, AuthenticatedGuard, AuthRouteGuard, MarketingAuthGuard, PlanGuard } from "@/router/guards";

const NotFoundPage = () => (
  <div className="mx-auto max-w-2xl px-4 py-20 text-center">
    <h1 className="font-display-zh text-3xl font-semibold">页面不存在</h1>
    <p className="mt-2 text-[var(--text-secondary)]">你访问的地址不在当前原型路由中。</p>
  </div>
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <LandingPage />,
      },
      {
        path: "changelog",
        element: <ChangelogPage />,
      },
      /* ── 产品文档（LightVela Docs） ──
         /docs             → 重定向到 /docs/overview
         /docs/:slug       → 一级文档，例如 /docs/overview、/docs/faq
         /docs/:cat/:slug  → 二级文档，例如 /docs/configuration/model */
      {
        element: <DocsLayout />,
        children: [
          {
            path: "docs",
            element: <Navigate to="/docs/overview" replace />,
          },
          {
            path: "docs/:slug",
            element: <DocsPage />,
          },
          {
            path: "docs/:category/:slug",
            element: <DocsPage />,
          },
        ],
      },
      {
        element: <MarketingAuthGuard />,
        children: [
          {
            path: "dashboard/create",
            element: <CreateOpenClawPage />,
          },
          {
            path: "subscribe",
            element: <SubscribePage />,
          },
          {
            path: "dashboard/setup",
            element: <OpenClawSetupPage />,
          },
          {
            path: "dashboard/success",
            element: <OpenClawSuccessPage />,
          },
          {
            path: "dashboard/settings",
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
          /* ── /dashboard 裸路径兜底：SPA 内部 navigate("/dashboard") 或用户手敲时，
             统一导向 /dashboard/settings，避免命中外层 NotFound。 ── */
          {
            path: "dashboard",
            element: <Navigate to="/dashboard/settings" replace />,
          },
          /* ── 老路径兼容：/openclaw/* 与 /create-openclaw 保留客户端重定向，
             避免老书签/外链 404。后续可在稳定一段时间后再删除。 ── */
          {
            path: "create-openclaw",
            element: <Navigate to="/dashboard/create" replace />,
          },
          {
            path: "openclaw/setup",
            element: <Navigate to="/dashboard/setup" replace />,
          },
          {
            path: "openclaw/success",
            element: <Navigate to="/dashboard/success" replace />,
          },
          {
            path: "openclaw/settings",
            element: <Navigate to="/dashboard/settings" replace />,
          },
          {
            path: "console/create",
            element: <Navigate to="/dashboard/create" replace />,
          },
          {
            path: "console/setup",
            element: <Navigate to="/dashboard/setup" replace />,
          },
          {
            path: "console/success",
            element: <Navigate to="/dashboard/success" replace />,
          },
          {
            path: "console/settings",
            element: <Navigate to="/dashboard/settings" replace />,
          },
        ],
      },
      {
        element: <MarketingLayout />,
        children: [
          {
            element: <AuthRouteGuard />,
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
            ],
          },
          {
            element: <AuthenticatedGuard />,
            children: [
              {
                element: <PlanGuard />,
                children: [
                  {
                    path: "plans/select",
                    element: <PlanSelectPage />,
                  },
                ],
              },
            ],
          },
        ],
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
            element: <Navigate to="/dashboard/settings" replace />,
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
    element: <NotFoundPage />,
  },
]);
