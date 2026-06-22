/**
 * 全站根布局：不渲染任何视觉元素，只挂 <ScrollRestoration />
 * 和国际站的「URL 语言前缀」自动补全。
 *
 * 作用：
 *   - SPA 切路由时 window 滚动条不会自动归零，会出现"切到概览还停在页面底部"的 bug。
 *   - react-router v6 的 <ScrollRestoration /> 要求挂在 RouterProvider 树内、
 *     且覆盖所有路由的一个公共布局里。
 *   - 国际站访问到 unprefixed SEO 路径（/docs/…、/about、/privacy-policy …）
 *     时，自动按当前 i18n.language 重定向到带 `/en` 或 `/zh` 前缀的版本，
 *     保证用户分享出来的 URL 与搜索引擎索引到的 URL 形态一致。
 *
 * 放置位置：router 最外层（path: "/"）的 element，让所有一级/二级页面都共享它。
 */

import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, ScrollRestoration, useLocation, useNavigate } from "react-router-dom";
import { CookieConsentBanner } from "@/components/site/cookie-consent-banner";
import { ImpersonationBanner } from "@/components/site/impersonation-banner";
import { MaintenanceAnnouncementBanner } from "@/components/site/maintenance-announcement-banner";
import { useRouteSeoMeta } from "@/lib/seo";
import { isGlobal, langPrefixRedirectTarget } from "@/lib/region";
import { ReactRouterAppNavigationProvider } from "@/lib/react-router-app-navigation";

/**
 * 国际站：mount + 路由变化时，把 unprefixed SEO 路径 replace 成带 `/en` 或 `/zh`
 * 前缀的版本。具体规则与白名单见 `langPrefixRedirectTarget`。
 *
 * 国内站：`langPrefixRedirectTarget` 始终返回 null，effect 内部直接走空跳出。
 * `isGlobal` 是编译期常量，cn 构建下整个 effect 体会被 terser 死代码消除。
 */
function useEnsureLangPrefix(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const { i18n } = useTranslation();

  useLayoutEffect(() => {
    if (!isGlobal) return;
    const locale: "zh-CN" | "en-US" =
      i18n.language === "zh-CN" ? "zh-CN" : "en-US";
    const target = langPrefixRedirectTarget(location.pathname, locale);
    if (target && target !== location.pathname) {
      navigate(target + location.search + location.hash, { replace: true });
    }
  }, [location.pathname, location.search, location.hash, i18n.language, navigate]);
}

export function RootLayout() {
  /* 路由感知的两个副作用：先补语言前缀，再让 useRouteSeoMeta 基于规范化后的
     pathname 写入 <title>/<meta>/<link rel="canonical">；顺序很重要——若先写
     SEO meta，再被 useEnsureLangPrefix 触发的 navigate replace 一次，就要再
     重渲一轮才能把 canonical 收敛到带前缀的 URL。 */
  useEnsureLangPrefix();
  useRouteSeoMeta();
  return (
    <>
      <ImpersonationBanner />
      <MaintenanceAnnouncementBanner />
      <ReactRouterAppNavigationProvider>
        <Outlet />
      </ReactRouterAppNavigationProvider>
      <CookieConsentBanner />
      <ScrollRestoration />
    </>
  );
}
