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
import { disableDatong, getDatong, initDatong, isDatongDevEnabled, setDatongUser, startDatongReport } from "@/observability/datong";
import { isGlobal } from "@/lib/region";

/**
 * 大同埋点桥接组件。
 *
 * 职责与 ProductAnalyticsBridge (posthog) 对称：
 *   1. 监听 cookie consent 变更（仅国际站需要）：国际站同意后 lazy-init 大同 SDK；国内站无需 consent 直接初始化
 *   2. 监听 session 变更，将当前登录用户 id 注入 SDK 公参
 *   3. 大同同时支持全球站与国内站，因此不像 posthog 只在 isGlobal 启用
 *
 * 挂载位置：`next-site/public-site-providers.tsx` 的 PublicSiteAppProviders 内，
 * 与 ProductAnalyticsBridge / RumUserBridge 并列。
 */
export const DatongTrackerBridge = () => {
  const { isAuthenticated, session, authReady } = useSession();
  const userId = isAuthenticated ? session.user?.id : null;

  useEffect(() => {
    // 国内站无 GDPR 要求，无需 cookie consent 门禁，直接上报；
    // 仅国际站需用户同意 cookie consent 后才初始化 SDK。
    const consentRequired = isGlobal;

    const syncConsent = () => {
      const consent = readStoredCookieConsent();
      // 国内站直接初始化上报；国际站需用户同意 cookie consent 后才初始化（dev 模式跳过）。
      if (!consentRequired || isDatongDevEnabled() || consent === COOKIE_CONSENT_ACCEPTED) {
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
      // 国内站直接初始化；国际站需 consent accepted（dev 模式跳过）
      if (!consentRequired || isDatongDevEnabled() || consent === COOKIE_CONSENT_ACCEPTED) {
        void initDatong(undefined, undefined, consent);
      }
    };

    const handleConsentChange = (event: Event) => {
      // 国内站不依赖 cookie consent，consent 变化不影响 SDK 状态（syncConsent 已处理初始化）
      if (!consentRequired) return;
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
    // authReady 后无论是否登录都开启上报，避免匿名用户事件永远缓存在 waitReport 队列里。
    // 已登录用户会在 setDatongUser → applyPendingUser 中提前 startReport，此处幂等。
    if (authReady) {
      startDatongReport();
    }
  }, [userId, authReady]);

  return null;
};
