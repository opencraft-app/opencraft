import { useEffect } from "react";
import { useSession } from "@/contexts/session-context";
import {
  COOKIE_CONSENT_CHANGED_EVENT,
  readStoredCookieConsent,
  type CookieConsentChangedDetail,
} from "@/lib/cookie-consent";
import { isGlobal } from "@/lib/region";
import { disablePostHog, initPostHog, setPostHogUser } from "@/observability/posthog";

export const ProductAnalyticsBridge = () => {
  const { isAuthenticated, session } = useSession();
  const userId = isAuthenticated ? session.user?.id : null;

  useEffect(() => {
    if (!isGlobal) return;

    const syncConsent = () => {
      const consent = readStoredCookieConsent();
      if (consent === "accepted") {
        void initPostHog(undefined, undefined, consent);
        return;
      }
      if (consent === "necessary") {
        disablePostHog();
      }
    };

    const handleConsentChange = (event: Event) => {
      const detail = (event as CustomEvent<CookieConsentChangedDetail>).detail;
      if (detail.value === "accepted") {
        void initPostHog(undefined, undefined, detail.value);
        return;
      }
      disablePostHog();
    };

    syncConsent();
    window.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, handleConsentChange);
    return () => {
      window.removeEventListener(COOKIE_CONSENT_CHANGED_EVENT, handleConsentChange);
    };
  }, []);

  useEffect(() => {
    if (!isGlobal) return;
    setPostHogUser(userId);
  }, [userId]);

  return null;
};
