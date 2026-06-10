import { Navigate, createBrowserRouter, useLocation } from "react-router-dom";
import { AppShellLayout } from "@/layouts/app-shell-layout";
import { MarketingLayout } from "@/layouts/marketing-layout";
import { RootLayout } from "@/layouts/root-layout";
import { LandingPage } from "@/pages/marketing/landing-page";
import { lazyNamed, lazyRoute } from "@/router/lazy-page";
import { AppAccessGuard, AuthenticatedGuard, AuthRouteGuard, MarketingAuthGuard, PlanGuard } from "@/router/guards";
import { isGlobal } from "@/lib/region";

const InvitePage = lazyNamed(() => import("@/pages/auth/invite-page"), "InvitePage");
const SignInPage = lazyNamed(() => import("@/pages/auth/sign-in-page"), "SignInPage");
const SignUpPage = lazyNamed(() => import("@/pages/auth/sign-up-page"), "SignUpPage");
const WeChatPayPage = lazyNamed(() => import("@/pages/auth/wechat-pay-page"), "WeChatPayPage");
const AccountProfilePage = lazyNamed(() => import("@/pages/app/account-profile-page"), "AccountProfilePage");
const BotTerminalPage = lazyNamed(() => import("@/pages/app/bot-terminal-page"), "BotTerminalPage");
const PlanSelectPage = lazyNamed(() => import("@/pages/app/plan-select-page"), "PlanSelectPage");
const SettingsPage = lazyNamed(() => import("@/pages/app/settings-page"), "SettingsPage");
const StyleLabPage = lazyNamed(() => import("@/pages/app/style-lab-page"), "StyleLabPage");
const WorkspacePage = lazyNamed(() => import("@/pages/app/workspace-page"), "WorkspacePage");
const CreateOpenClawPage = lazyNamed(() => import("@/pages/marketing/create-openclaw-page"), "CreateOpenClawPage");
const SubscribePage = lazyNamed(() => import("@/pages/marketing/subscribe-page"), "SubscribePage");
const PrivacyPolicyPage = lazyNamed(() => import("@/pages/marketing/privacy-policy-page"), "PrivacyPolicyPage");
const CookiePolicyPage = lazyNamed(() => import("@/pages/marketing/cookie-policy-page"), "CookiePolicyPage");
const OpenSourceLicensesPage = lazyNamed(() => import("@/pages/marketing/open-source-licenses-page"), "OpenSourceLicensesPage");
const OpenClawSetupPage = lazyNamed(() => import("@/pages/marketing/openclaw-setup-page"), "OpenClawSetupPage");
const OpenClawSuccessPage = lazyNamed(() => import("@/pages/marketing/openclaw-success-page"), "OpenClawSuccessPage");
const OpenClawSettingsPage = lazyNamed(() => import("@/pages/marketing/openclaw-settings-page"), "OpenClawSettingsPage");
const AccountPage = lazyNamed(() => import("@/pages/marketing/account-page"), "AccountPage");
const AccountOrdersPage = lazyNamed(() => import("@/pages/marketing/account-orders-page"), "AccountOrdersPage");
const TATDeviceBindPage = lazyNamed(() => import("@/pages/marketing/tat-device-bind-page"), "TATDeviceBindPage");
const AboutPage = lazyNamed(() => import("@/pages/marketing/about-page"), "AboutPage");
const ChangelogPage = lazyNamed(() => import("@/pages/marketing/changelog-page"), "ChangelogPage");
const DocsPage = lazyNamed(() => import("@/pages/docs/docs-page"), "DocsPage");
const DocsLayout = lazyNamed(() => import("@/components/docs/docs-layout"), "DocsLayout");

const NotFoundPage = () => (
  <div className="mx-auto max-w-2xl px-4 py-20 text-center">
    <h1 className="font-display-zh text-3xl font-semibold">页面不存在</h1>
    <p className="mt-2 text-[var(--text-secondary)]">你访问的地址不在当前原型路由中。</p>
  </div>
);

const RedirectToAgents = () => {
  const location = useLocation();
  return <Navigate to={{ pathname: "/agents", search: location.search }} replace />;
};

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <LandingPage />,
      },
      ...(!isGlobal
        ? [
            {
              path: "changelog",
              element: lazyRoute(ChangelogPage),
            },
          ]
        : []),
      {
        path: "about",
        element: lazyRoute(AboutPage),
      },
      /* ── 产品文档（LightVela Docs） ──
         /docs             → 重定向到 /docs/overview
         /docs/:slug       → 一级文档，例如 /docs/overview、/docs/faq
         /docs/:cat/:slug  → 二级文档，例如 /docs/configuration/model */
      {
        element: lazyRoute(DocsLayout),
        children: [
          {
            path: "docs",
            element: <Navigate to="/docs/overview" replace />,
          },
          {
            path: "docs/:slug",
            element: lazyRoute(DocsPage),
          },
          {
            path: "docs/:category/:slug",
            element: lazyRoute(DocsPage),
          },
        ],
      },
      ...(isGlobal
        ? [
            {
              path: "privacy-policy",
              element: lazyRoute(PrivacyPolicyPage),
            },
            {
              path: "cookie-policy",
              element: lazyRoute(CookiePolicyPage),
            },
            {
              path: "open-source-licenses",
              element: lazyRoute(OpenSourceLicensesPage),
            },
          ]
        : []),
      {
        element: <MarketingAuthGuard />,
        children: [
          {
            path: "dashboard/create",
            element: lazyRoute(CreateOpenClawPage),
          },
          {
            path: "subscribe",
            element: lazyRoute(SubscribePage),
          },
          {
            path: "dashboard/setup",
            element: lazyRoute(OpenClawSetupPage),
          },
          {
            path: "dashboard/success",
            element: lazyRoute(OpenClawSuccessPage),
          },
          {
            path: "agents",
            element: lazyRoute(OpenClawSettingsPage),
          },
          {
            path: "agents/:section",
            element: lazyRoute(OpenClawSettingsPage),
          },
          {
            path: "account",
            element: lazyRoute(AccountPage),
          },
          {
            path: "account/orders",
            element: lazyRoute(AccountOrdersPage),
          },
          {
            path: "tat/device-bind",
            element: lazyRoute(TATDeviceBindPage),
          },
          /* ── /dashboard 与 /dashboard/settings 已迁移到 /agents。
             保留客户端兼容跳转，避免老书签/外链 404，并保留 ?creating=... 等查询参数。 ── */
          {
            path: "dashboard",
            element: <RedirectToAgents />,
          },
          {
            path: "dashboard/settings",
            element: <RedirectToAgents />,
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
            element: <RedirectToAgents />,
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
            element: <RedirectToAgents />,
          },
        ],
      },
      {
        path: "auth/wechat-pay",
        element: lazyRoute(WeChatPayPage),
      },
      {
        element: <MarketingLayout />,
        children: [
          {
            element: <AuthRouteGuard />,
            children: [
              {
                path: "auth/sign-in",
                element: lazyRoute(SignInPage),
              },
              {
                path: "auth/sign-up",
                element: lazyRoute(SignUpPage),
              },
              {
                path: "auth/sign-up-code",
                element: <Navigate to="/auth/sign-in" replace />,
              },
              {
                path: "auth/invite",
                element: lazyRoute(InvitePage),
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
                    element: lazyRoute(PlanSelectPage),
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
            element: lazyRoute(AccountProfilePage),
          },
          {
            path: "/bots/:id/workspace",
            element: lazyRoute(WorkspacePage),
          },
          {
            path: "/bots/:id/settings",
            element: lazyRoute(SettingsPage),
          },
          {
            path: "/bots/:id/terminal",
            element: lazyRoute(BotTerminalPage),
          },
          {
            path: "*",
            element: <Navigate to="/agents" replace />,
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
            element: lazyRoute(StyleLabPage),
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
