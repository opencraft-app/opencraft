// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
export const COOKIE_CONSENT_STORAGE_KEY = "lightvela-cookie-consent-v1";
export const COOKIE_CONSENT_CHANGED_EVENT = "lightvela-cookie-consent-changed";
export const COOKIE_CONSENT_ACCEPTED = "accepted";
export const COOKIE_CONSENT_NECESSARY = "necessary";

export type CookieConsentValue = typeof COOKIE_CONSENT_ACCEPTED | typeof COOKIE_CONSENT_NECESSARY;

export type CookieConsentChangedDetail = {
  value: CookieConsentValue;
};

export const readStoredCookieConsent = (): CookieConsentValue | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    return value === COOKIE_CONSENT_ACCEPTED || value === COOKIE_CONSENT_NECESSARY ? value : null;
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
