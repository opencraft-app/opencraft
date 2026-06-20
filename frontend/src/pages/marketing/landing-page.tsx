/**
 * LightVela 官网落地页
 * UI 实现：feature/iztzhou-lightvela（Figma 导出）
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { LoginModal, InviteCodeModal } from "@/components/site/login-modal";
import { ProductFooter } from "@/components/site/product-chrome";
import { useSession } from "@/contexts/session-context";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { oauthErrorMessage } from "@/lib/oauth";
import { AGENTS_HOME_PATH, getAgentCreatingPath } from "@/router/paths";

import HeaderSection from "@/imports/Frame2147230025/sections/HeaderSection";
import HeroSection from "@/imports/Frame2147230025/sections/HeroSection";
import BrandIconsSection from "@/imports/Frame2147230025/sections/BrandIconsSection";
import FeatureSection, { CardsSection } from "@/imports/Frame2147230025/sections/FeatureSection";
import ProcessSection from "@/imports/Frame2147230025/sections/ProcessSection";
import CtaSection from "@/imports/Frame2147230025/sections/CtaSection";

// 落地页全局样式隔离层：始终生效，用「无层 + !important」锁定首页字体/链接等
// 关键样式，免疫 tea 多包注入的无层全局 reset（详见 CSS 注释）。
import "./landing-page-isolation.css";

export const LandingPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated } = useSession();
  const { bots, isSubscribed } = useOpenClaw();
  const [showLogin, setShowLogin] = useState(false);
  const [showInviteCode, setShowInviteCode] = useState(false);
  const oauthError = useMemo(() => new URLSearchParams(location.search).get("oauth_error"), [location.search]);
  const loginErrorMessage = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);

  const hasBots = bots.length > 0;

  useEffect(() => {
    if (!oauthError) return;
    setShowLogin(true);
  }, [oauthError, navigate]);

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

  /**
   * 「立即创建」按钮统一处理：
   * - 未登录 → 弹登录框
   * - 已登录且已订阅 → 进入 dashboard（无龙虾时自动创建）
   * - 已登录未订阅 → 跳套餐选择页
   */
  const handleCreateClick = useCallback(() => {
    if (!isAuthenticated) {
      setShowLogin(true);
      return;
    }
    if (isSubscribed) {
      navigate(hasBots ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
    } else {
      navigate("/subscribe");
    }
  }, [isAuthenticated, isSubscribed, hasBots, navigate]);

  return (
    <div className="lw-landing-root w-full bg-white overflow-x-hidden">
      <div className="relative">
        <HeaderSection onLoginClick={openLogin} onCreateClick={handleCreateClick} />
        <HeroSection onCreateClick={handleCreateClick} />
      </div>
      <BrandIconsSection />
      <FeatureSection />
      <CardsSection />
      <ProcessSection />
      <CtaSection onCreateClick={handleCreateClick} />
      <ProductFooter />

      <LoginModal
        open={showLogin}
        onClose={handleCloseLogin}
        initialError={loginErrorMessage}
        onSuccess={() => {
          if (isSubscribed) {
            navigate(hasBots ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
          } else {
            navigate("/subscribe");
          }
        }}
      />
      <InviteCodeModal
        open={showInviteCode}
        onClose={() => setShowInviteCode(false)}
        onSuccess={handleInviteSuccess}
      />
    </div>
  );
};
