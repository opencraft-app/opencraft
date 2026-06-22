import { Navigate, createBrowserRouter, useLocation } from "react-router-dom";
import { AppShellLayout } from "@/layouts/app-shell-layout";
import { MarketingLayout } from "@/layouts/marketing-layout";
import { RootLayout } from "@/layouts/root-layout";
import { lazyNamed, lazyRoute } from "@/router/lazy-page";
import { AGENTS_HOME_PATH } from "@/router/paths";
import { AppAccessGuard, AuthenticatedGuard, AuthRouteGuard, MarketingAuthGuard, PlanGuard } from "@/router/guards";
import { isGlobal } from "@/lib/region";
import { useRouteSeoMeta } from "@/lib/seo";

const LandingPage = lazyNamed(() => import("@/pages/marketing/landing-page"), "LandingPage");

const InvitePage = lazyNamed(() => import("@/pages/auth/invite-page"), "InvitePage");
const SignInPage = lazyNamed(() => import("@/pages/auth/sign-in-page"), "SignInPage");
const SignUpPage = lazyNamed(() => import("@/pages/auth/sign-up-page"), "SignUpPage");
const WeChatPayPage = lazyNamed(() => import("@/pages/auth/wechat-pay-page"), "WeChatPayPage");
const EmailBindResultPage = lazyNamed(() => import("@/pages/auth/email-bind-result-page"), "EmailBindResultPage");
const AccountProfilePage = lazyNamed(() => import("@/pages/app/account-profile-page"), "AccountProfilePage");
const BotTerminalPage = lazyNamed(() => import("@/pages/app/bot-terminal-page"), "BotTerminalPage");
const PlanSelectPage = lazyNamed(() => import("@/pages/app/plan-select-page"), "PlanSelectPage");
const SettingsPage = lazyNamed(() => import("@/pages/app/settings-page"), "SettingsPage");
const StyleLabPage = lazyNamed(() => import("@/pages/app/style-lab-page"), "StyleLabPage");
const WorkspacePage = lazyNamed(() => import("@/pages/app/workspace-page"), "WorkspacePage");
const CreateOpenClawPage = lazyNamed(() => import("@/pages/marketing/create-openclaw-page"), "CreateOpenClawPage");
const PrivacyPolicyPage = lazyNamed(() => import("@/pages/marketing/privacy-policy-page"), "PrivacyPolicyPage");
const CookiePolicyPage = lazyNamed(() => import("@/pages/marketing/cookie-policy-page"), "CookiePolicyPage");
const OpenSourceLicensesPage = lazyNamed(() => import("@/pages/marketing/open-source-licenses-page"), "OpenSourceLicensesPage");
const OpenClawSetupPage = lazyNamed(() => import("@/pages/marketing/openclaw-setup-page"), "OpenClawSetupPage");
const OpenClawSuccessPage = lazyNamed(() => import("@/pages/marketing/openclaw-success-page"), "OpenClawSuccessPage");
const AccountPage = lazyNamed(() => import("@/pages/marketing/account-page"), "AccountPage");
const AccountOrdersPage = lazyNamed(() => import("@/pages/marketing/account-orders-page"), "AccountOrdersPage");
const OpenClawSettingsRoutePage = lazyNamed(() => import("@/router/openclaw-settings-route"), "OpenClawSettingsRoutePage");
const TATDeviceBindPage = lazyNamed(() => import("@/pages/marketing/tat-device-bind-page"), "TATDeviceBindPage");
const AboutPage = lazyNamed(() => import("@/pages/marketing/about-page"), "AboutPage");
const ChangelogPage = lazyNamed(() => import("@/pages/marketing/changelog-page"), "ChangelogPage");
const DocsPage = lazyNamed(() => import("@/pages/docs/docs-page"), "DocsPage");
const DocsLayout = lazyNamed(() => import("@/components/docs/docs-layout"), "DocsLayout");

const NotFoundPage = () => {
  useRouteSeoMeta();

  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="font-display-zh text-3xl font-semibold">页面不存在</h1>
      <p className="mt-2 text-[var(--text-secondary)]">你访问的地址不在当前原型路由中。</p>
    </div>
  );
};

const RedirectToAgents = () => {
  const location = useLocation();
  return <Navigate to={{ pathname: AGENTS_HOME_PATH, search: location.search }} replace />;
};

/**
 * 国际站 SEO 路由（landing / about / docs / 法律页）的 children 抽象。
 * 同一组 children 同时挂在「无语言前缀」和「带语言前缀（/en、/zh）」两套父路由下，
 * 以支持 multi-URL i18n（Google 索引 /en/docs/... 与 /zh/docs/... 为不同语言版本）。
 *
 * 所有 children 复用同一组 React 组件——locale 由 i18n 单例运行时决定，
 * URL 前缀只是声明给搜索引擎的语言标识。
 */
const seoSiteRouteChildren = [
  {
    index: true,
    element: lazyRoute(LandingPage),
  },
  {
    path: "changelog",
    element: lazyRoute(ChangelogPage, { chrome: "site" }),
  },
  {
    path: "about",
    element: lazyRoute(AboutPage, { chrome: "site" }),
  },
  /* ── 产品文档（LightVela Docs） ──
     /docs             → 重定向到 /docs/overview
     /docs/:slug       → 一级文档，例如 /docs/overview、/docs/faq
     /docs/:cat/:slug  → 二级文档，例如 /docs/configuration/model */
  {
    element: lazyRoute(DocsLayout, { chrome: "site" }),
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
];

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      ...seoSiteRouteChildren,
      /**
       * 国际站镜像路由：把同样一组 SEO 子路由再挂一份到 `/en/*` `/zh/*` 下。
       * 这些 child 路由相对于父路由是「无前缀」的——例如 `/en/about` 命中
       * 父 `/en` + child `about`；命中后渲染同一组 React 组件。
       *
       * 国内站不挂这一段（编译期 isGlobal=false → 整个数组被 terser 消除）。
       */
      ...(isGlobal
        ? [
            {
              path: "en",
              children: seoSiteRouteChildren,
            },
            {
              path: "zh",
              children: seoSiteRouteChildren,
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
            path: "dashboard/setup",
            element: lazyRoute(OpenClawSetupPage),
          },
          {
            path: "dashboard/success",
            element: lazyRoute(OpenClawSuccessPage),
          },
          {
            path: "agents",
            element: lazyRoute(OpenClawSettingsRoutePage, { chrome: "product" }),
          },
          {
            path: "agents/:section",
            element: lazyRoute(OpenClawSettingsRoutePage, { chrome: "product" }),
          },
          {
            path: "account",
            element: lazyRoute(AccountPage, { chrome: "product" }),
          },
          {
            path: "account/orders",
            element: lazyRoute(AccountOrdersPage, { chrome: "site" }),
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
            path: "auth/email-bind-result",
            element: lazyRoute(EmailBindResultPage),
          },
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
            element: <Navigate to={AGENTS_HOME_PATH} replace />,
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
