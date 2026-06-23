import { describe, expect, it, vi } from "vitest";
import {
  COOKIE_CONSENT_ACCEPTED,
  COOKIE_CONSENT_CHANGED_EVENT,
  COOKIE_CONSENT_NECESSARY,
  COOKIE_CONSENT_STORAGE_KEY,
  readStoredCookieConsent,
  storeCookieConsent,
  type CookieConsentChangedDetail,
} from "@/lib/cookie-consent";

describe("cookie consent storage", () => {
  it("reads only supported consent values", () => {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, COOKIE_CONSENT_ACCEPTED);
    expect(readStoredCookieConsent()).toBe(COOKIE_CONSENT_ACCEPTED);

    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, COOKIE_CONSENT_NECESSARY);
    expect(readStoredCookieConsent()).toBe(COOKIE_CONSENT_NECESSARY);

    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, "other");
    expect(readStoredCookieConsent()).toBeNull();
  });

  it("stores consent and emits a change event", () => {
    const listener = vi.fn((event: Event) => {
      expect((event as CustomEvent<CookieConsentChangedDetail>).detail).toEqual({
        value: COOKIE_CONSENT_ACCEPTED,
      });
    });
    window.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, listener);

    storeCookieConsent(COOKIE_CONSENT_ACCEPTED);

    expect(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY)).toBe(COOKIE_CONSENT_ACCEPTED);
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(COOKIE_CONSENT_CHANGED_EVENT, listener);
  });
});
