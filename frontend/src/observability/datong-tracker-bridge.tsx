'use client';

import { useEffect } from "react";
import { useSession } from "@/contexts/session-context";
import {
  COOKIE_CONSENT_ACCEPTED,
  COOKIE_CONSENT_CHANGED_EVENT,
  COOKIE_CONSENT_NECESSARY,
  readStoredCookieConsent,
  type CookieConsentChangedDetail,
} from "@/lib/cookie-consent";
import { disableDatong, getDatong, initDatong, isDatongDevEnabled, setDatongUser } from "@/observability/datong";

/**
 * 大同埋点桥接组件。
 *
 * 职责与 ProductAnalyticsBridge (posthog) 对称：
 *   1. 监听 cookie consent 变更，同意后 lazy-init 大同 SDK
 *   2. 监听 session 变更，将当前登录用户 id 注入 SDK 公参
 *   3. 大同同时支持全球站与国内站，因此不像 posthog 只在 isGlobal 启用
 *
 * 挂载位置：`next-site/public-site-providers.tsx` 的 PublicSiteAppProviders 内，
 * 与 ProductAnalyticsBridge / RumUserBridge 并列。
 */
export const DatongTrackerBridge = () => {
  const { isAuthenticated, session } = useSession();
  const userId = isAuthenticated ? session.user?.id : null;

  useEffect(() => {
    const syncConsent = () => {
      const consent = readStoredCookieConsent();
      // dev 模式（NEXT_PUBLIC_DATONG_DEV_ENABLED=true）下跳过 cookie consent 门禁，
      // 便于本地联调埋点；生产模式仍需用户同意 cookie consent 后才初始化。
      if (isDatongDevEnabled() || consent === COOKIE_CONSENT_ACCEPTED) {
        void initDatong(undefined, undefined, consent);
        return;
      }
      if (consent === COOKIE_CONSENT_NECESSARY) {
        disableDatong();
      }
    };

    const retryAcceptedConsent = () => {
      if (getDatong()) return;
      if (document.visibilityState === "hidden") return;
      const consent = readStoredCookieConsent();
      if (consent === COOKIE_CONSENT_ACCEPTED || isDatongDevEnabled()) {
        void initDatong(undefined, undefined, consent);
      }
    };

    const handleConsentChange = (event: Event) => {
      const detail = (event as CustomEvent<CookieConsentChangedDetail>).detail;
      if (detail.value === COOKIE_CONSENT_ACCEPTED || isDatongDevEnabled()) {
        void initDatong(undefined, undefined, detail.value);
        return;
      }
      disableDatong();
    };

    syncConsent();
    window.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, handleConsentChange);
    window.addEventListener("online", retryAcceptedConsent);
    document.addEventListener("visibilitychange", retryAcceptedConsent);
    return () => {
      window.removeEventListener(COOKIE_CONSENT_CHANGED_EVENT, handleConsentChange);
      window.removeEventListener("online", retryAcceptedConsent);
      document.removeEventListener("visibilitychange", retryAcceptedConsent);
    };
  }, []);

  useEffect(() => {
    setDatongUser(userId);
  }, [userId]);

  return null;
};
