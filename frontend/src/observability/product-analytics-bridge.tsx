import { useEffect } from "react";
import { useSession } from "@/contexts/session-context";
import {
  COOKIE_CONSENT_ACCEPTED,
  COOKIE_CONSENT_CHANGED_EVENT,
  COOKIE_CONSENT_NECESSARY,
  readStoredCookieConsent,
  type CookieConsentChangedDetail,
} from "@/lib/cookie-consent";
import { isGlobal } from "@/lib/region";
import { disablePostHog, getPostHog, initPostHog, setPostHogUser } from "@/observability/posthog";

export const ProductAnalyticsBridge = () => {
  const { isAuthenticated, session } = useSession();
  const userId = isAuthenticated ? session.user?.id : null;

  useEffect(() => {
    if (!isGlobal) return;

    const syncConsent = () => {
      const consent = readStoredCookieConsent();
      if (consent === COOKIE_CONSENT_ACCEPTED) {
        void initPostHog(undefined, undefined, consent);
        return;
      }
      if (consent === COOKIE_CONSENT_NECESSARY) {
        disablePostHog();
      }
    };

    const retryAcceptedConsent = () => {
      if (getPostHog()) return;
      if (document.visibilityState === "hidden") return;
      const consent = readStoredCookieConsent();
      if (consent === COOKIE_CONSENT_ACCEPTED) {
        void initPostHog(undefined, undefined, consent);
      }
    };

    const handleConsentChange = (event: Event) => {
      const detail = (event as CustomEvent<CookieConsentChangedDetail>).detail;
      if (detail.value === COOKIE_CONSENT_ACCEPTED) {
        void initPostHog(undefined, undefined, detail.value);
        return;
      }
      disablePostHog();
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
    if (!isGlobal) return;
    setPostHogUser(userId);
  }, [userId]);

  return null;
};
