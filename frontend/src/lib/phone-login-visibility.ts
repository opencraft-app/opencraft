import { useEffect, useState } from "react";

const PHONE_LOGIN_VISIBILITY_EVENT = "lightvela:phone-login-visibility";

type PhoneLoginVisibilityHost = Window & typeof globalThis & {
  show_phone_login?: unknown;
  __LIGHTVELA_SHOW_PHONE_LOGIN__?: boolean;
};

const resolveHost = (host?: PhoneLoginVisibilityHost): PhoneLoginVisibilityHost | null => {
  if (host) return host;
  return typeof window === "undefined" ? null : window;
};

export const isPhoneLoginVisible = (host?: PhoneLoginVisibilityHost) =>
  resolveHost(host)?.__LIGHTVELA_SHOW_PHONE_LOGIN__ === true;

export const setPhoneLoginVisible = (visible: boolean, host?: PhoneLoginVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return false;
  target.__LIGHTVELA_SHOW_PHONE_LOGIN__ = visible;
  target.dispatchEvent(new CustomEvent<boolean>(PHONE_LOGIN_VISIBILITY_EVENT, { detail: visible }));
  return visible;
};

export const installShowPhoneLoginHelper = (host?: PhoneLoginVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return () => undefined;
  const originalShowPhoneLogin = target.show_phone_login;

  target.show_phone_login = () => {
    setPhoneLoginVisible(true, target);
    target.console.info("Phone login is now visible.");
    return true;
  };

  return () => {
    if (originalShowPhoneLogin === undefined) {
      delete target.show_phone_login;
      return;
    }
    target.show_phone_login = originalShowPhoneLogin;
  };
};

export const usePhoneLoginVisibility = () => {
  const [visible, setVisible] = useState(() => isPhoneLoginVisible());

  useEffect(() => {
    const syncVisibility = () => setVisible(isPhoneLoginVisible());
    syncVisibility();
    window.addEventListener(PHONE_LOGIN_VISIBILITY_EVENT, syncVisibility);
    return () => window.removeEventListener(PHONE_LOGIN_VISIBILITY_EVENT, syncVisibility);
  }, []);

  return visible;
};
