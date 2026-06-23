import { describe, expect, it, vi } from "vitest";
import {
  COOKIE_CONSENT_CHANGED_EVENT,
  COOKIE_CONSENT_STORAGE_KEY,
  readStoredCookieConsent,
  storeCookieConsent,
  type CookieConsentChangedDetail,
} from "@/lib/cookie-consent";

describe("cookie consent storage", () => {
  it("reads only supported consent values", () => {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, "accepted");
    expect(readStoredCookieConsent()).toBe("accepted");

    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, "necessary");
    expect(readStoredCookieConsent()).toBe("necessary");

    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, "other");
    expect(readStoredCookieConsent()).toBeNull();
  });

  it("stores consent and emits a change event", () => {
    const listener = vi.fn((event: Event) => {
      expect((event as CustomEvent<CookieConsentChangedDetail>).detail).toEqual({
        value: "accepted",
      });
    });
    window.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, listener);

    storeCookieConsent("accepted");

    expect(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY)).toBe("accepted");
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(COOKIE_CONSENT_CHANGED_EVENT, listener);
  });
});
