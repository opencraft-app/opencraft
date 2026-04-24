/**
 * LightClaw 官网落地页
 * 参考设计哲学：「冰火实验室」— 新瑞士主义 × 有机科技感
 * 叙事主线：它是什么 → 能帮我做什么 → 在哪用 → 难不难 → 靠谱吗 → 我要试试
 * Hero 区域采用元素居中结构
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { LoginModal, InviteCodeModal } from "@/components/site/login-modal";
import { useSession } from "@/contexts/session-context";
import { useOpenClaw } from "@/contexts/openclaw-context";

import { LandingNavbar } from "./landing/landing-navbar";
import { HeroSection } from "./landing/hero-section";
import { WhatItDoesSection } from "./landing/what-it-does-section";
import { WhereToUseSection } from "./landing/where-to-use-section";
import { HowEasySection } from "./landing/how-easy-section";
import { WhyTrustSection } from "./landing/why-trust-section";
import { CTAFooterSection } from "./landing/cta-footer-section";

export const oauthErrorMessage = (oauthError: string | null) => {
  if (oauthError === "qq_exchange_failed" || oauthError === "qq_identity_failed" || oauthError === "qq_sign_in_failed") {
    return "QQ 登录暂时失败，请稍后重试。";
  }
  if (oauthError === "invite_required") {
    return "首次使用需要先通过邀请码校验。";
  }
  if (oauthError === "qq_state_mismatch") {
    return "登录态已过期，请重新发起 QQ 登录。";
  }
  return null;
};

export const LandingPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, session } = useSession();
  const { bots } = useOpenClaw();
  const [showLogin, setShowLogin] = useState(false);
  const [showInviteCode, setShowInviteCode] = useState(false);
  const oauthError = useMemo(() => new URLSearchParams(location.search).get("oauth_error"), [location.search]);
  const loginErrorMessage = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);

  const hasBots = bots.length > 0;

  useEffect(() => {
    if (!oauthError) return;
    if (oauthError === "invite_required") {
      setShowInviteCode(true);
      navigate("/", { replace: true });
    } else {
      setShowLogin(true);
    }
  }, [oauthError, navigate]);

  useEffect(() => {
    if (session.stage === "authenticated" && session.user?.inviteRequired) {
      setShowInviteCode(true);
    }
  }, [session.stage, session.user]);

  const handleCloseLogin = () => {
    setShowLogin(false);
    if (oauthError) {
      navigate("/", { replace: true });
    }
  };

  const handleInviteSuccess = () => {
    setShowInviteCode(false);
    navigate("/", { replace: true });
  };

  const openLogin = () => setShowLogin(true);

  /* ── 全局鼠标跟随微光 ── */
  const handleGlobalMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.setProperty("--mouse-x", `${e.clientX}px`);
    el.style.setProperty("--mouse-y", `${e.clientY}px`);
  }, []);

  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}
      onMouseMove={handleGlobalMouseMove}
    >
      {/* 鼠标跟随微光层 */}
      <div className="lw-cursor-glow pointer-events-none fixed inset-0 z-50" aria-hidden />

      <LandingNavbar onLoginClick={openLogin} isLoggedIn={isAuthenticated} />

      <main className="z-10 flex-grow">
        <HeroSection onLoginClick={openLogin} isLoggedIn={isAuthenticated} hasBots={hasBots} />
        <WhatItDoesSection />
        <WhereToUseSection />
        <HowEasySection />
        <WhyTrustSection />
        <CTAFooterSection onLoginClick={openLogin} isLoggedIn={isAuthenticated} />
      </main>

      <LoginModal open={showLogin} onClose={handleCloseLogin} initialError={loginErrorMessage} onSuccess={() => navigate("/openclaw/settings")} />
      <InviteCodeModal open={showInviteCode} onClose={() => setShowInviteCode(false)} onSuccess={handleInviteSuccess} />
    </div>
  );
};
