export const COOKIE_CONSENT_STORAGE_KEY = "lightvela-cookie-consent-v1";
export const COOKIE_CONSENT_CHANGED_EVENT = "lightvela-cookie-consent-changed";

export type CookieConsentValue = "accepted" | "necessary";

export type CookieConsentChangedDetail = {
  value: CookieConsentValue;
};

export const readStoredCookieConsent = (): CookieConsentValue | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    return value === "accepted" || value === "necessary" ? value : null;
  } catch {
    return null;
  }
};

export const storeCookieConsent = (value: CookieConsentValue): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, value);
  } catch {
    /* localStorage may be unavailable in private mode; keep the in-memory UI flow moving. */
  }

  window.dispatchEvent(
    new CustomEvent<CookieConsentChangedDetail>(COOKIE_CONSENT_CHANGED_EVENT, {
      detail: { value },
    }),
  );
};
