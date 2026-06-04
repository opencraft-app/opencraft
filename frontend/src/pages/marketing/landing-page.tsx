/**
 * LightVela 官网落地页
 * UI 实现：feature/iztzhou-lightvela（Figma 导出）
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LandingPageV2 } from "./landing-page-v2";

import { LoginModal, InviteCodeModal } from "@/components/site/login-modal";
import { useSession } from "@/contexts/session-context";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { oauthErrorMessage } from "@/lib/oauth";

import HeaderSection from "@/imports/Frame2147230025/sections/HeaderSection";
import HeroSection from "@/imports/Frame2147230025/sections/HeroSection";
import BrandIconsSection from "@/imports/Frame2147230025/sections/BrandIconsSection";
import FeatureSection, { CardsSection } from "@/imports/Frame2147230025/sections/FeatureSection";
import ProcessSection from "@/imports/Frame2147230025/sections/ProcessSection";
import CtaSection from "@/imports/Frame2147230025/sections/CtaSection";
import FooterSection from "@/imports/Frame2147230025/sections/FooterSection";

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

  return (
    <div className="w-full bg-white overflow-x-hidden">
      <div className="relative">
        <HeaderSection />
        <HeroSection />
      </div>
      <BrandIconsSection />
      <FeatureSection />
      <CardsSection />
      <ProcessSection />
      <CtaSection />
      <FooterSection />

      <LoginModal
        open={showLogin}
        onClose={handleCloseLogin}
        initialError={loginErrorMessage}
        onSuccess={() => {
          if (isSubscribed) {
            navigate(hasBots ? "/dashboard/settings" : "/dashboard/settings?creating=true");
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
