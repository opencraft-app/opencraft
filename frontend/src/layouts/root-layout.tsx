/**
 * 全站根布局：不渲染任何视觉元素，只挂 <ScrollRestoration />。
 *
 * 作用：
 *   - SPA 切路由时 window 滚动条不会自动归零，会出现"切到概览还停在页面底部"的 bug。
 *   - react-router v6 的 <ScrollRestoration /> 要求挂在 RouterProvider 树内、
 *     且覆盖所有路由的一个公共布局里。
 *
 * 放置位置：router 最外层（path: "/"）的 element，让所有一级/二级页面都共享它。
 */

import { Outlet, ScrollRestoration } from "react-router-dom";
import { CookieConsentBanner } from "@/components/site/cookie-consent-banner";
import { ImpersonationBanner } from "@/components/site/impersonation-banner";
import { MaintenanceAnnouncementBanner } from "@/components/site/maintenance-announcement-banner";

export function RootLayout() {
  return (
    <>
      <ImpersonationBanner />
      <MaintenanceAnnouncementBanner />
      <Outlet />
      <CookieConsentBanner />
      <ScrollRestoration />
    </>
  );
}
