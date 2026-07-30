import { afterEach, describe, expect, it } from "vitest";
import {
  installShowPhoneLoginHelper,
  isPhoneLoginVisible,
  setPhoneLoginVisible,
} from "@/lib/phone-login-visibility";

describe("phone login visibility", () => {
  afterEach(() => {
    setPhoneLoginVisible(false);
    delete window.show_phone_login;
  });

  it("reveals phone login only after show_phone_login()", () => {
    expect(isPhoneLoginVisible()).toBe(false);

    const uninstall = installShowPhoneLoginHelper();

    expect(typeof window.show_phone_login).toBe("function");
    expect(window.show_phone_login?.()).toBe(true);
    expect(isPhoneLoginVisible()).toBe(true);
    uninstall();
  });
});
