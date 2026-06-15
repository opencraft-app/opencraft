/**
 * 文档站布局：直接复用主站的 `LandingNavbar`，确保顶栏跨页完全一致
 * （高度、间距、导航项、登录 CTA、头像菜单都同一份）。
 *
 * 布局：
 *   ┌──────────── LandingNavbar (fixed, 60px) ─────────────────┐
 *   │  [Logo]  概览 · 更新日志 · 产品文档         [登录 / 头像] │
 *   ├──── pt-[60px] 占位，避免内容被 fixed 顶栏遮挡 ──────────┤
 *   │  [Sidebar(含搜索)]   [Content]   [Toc]                   │
 *   ├──────────────── Legal Footer ────────────────────────────┤
 */

import { useState } from "react";
import { Outlet } from "react-router-dom";
import { LandingNavbar } from "@/pages/marketing/landing/landing-navbar";
import { LegalFooter } from "@/components/site/legal-footer";
import { LoginModal } from "@/components/site/login-modal";

export function DocsLayout() {
  const [showLogin, setShowLogin] = useState(false);

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <LandingNavbar onLoginClick={() => setShowLogin(true)} />

      {/* LandingNavbar 为 fixed（h-[60px]），此处留出占位避免被遮挡 */}
      <div className="pt-[60px]">
        <Outlet />
      </div>

      <LegalFooter />

      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />

      {/* 全站滚动重置已抬升到 RootLayout，这里无需单独处理 */}
    </div>
  );
}
