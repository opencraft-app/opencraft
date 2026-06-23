import { useEffect, useState } from "react";

const GITHUB_LOGIN_VISIBILITY_EVENT = "lightvela:github-login-visibility";

type GitHubLoginVisibilityHost = Window & typeof globalThis & {
  show_github_login?: unknown;
  __LIGHTVELA_SHOW_GITHUB_LOGIN__?: boolean;
};

const resolveHost = (host?: GitHubLoginVisibilityHost): GitHubLoginVisibilityHost | null => {
  if (host) return host;
  return typeof window === "undefined" ? null : window;
};

export const isGitHubLoginVisible = (host?: GitHubLoginVisibilityHost) => resolveHost(host)?.__LIGHTVELA_SHOW_GITHUB_LOGIN__ === true;

export const setGitHubLoginVisible = (visible: boolean, host?: GitHubLoginVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return false;
  target.__LIGHTVELA_SHOW_GITHUB_LOGIN__ = visible;
  target.dispatchEvent(new CustomEvent<boolean>(GITHUB_LOGIN_VISIBILITY_EVENT, { detail: visible }));
  return visible;
};

export const installShowGitHubLoginHelper = (host?: GitHubLoginVisibilityHost) => {
  const target = resolveHost(host);
  if (!target) return () => undefined;
  const originalShowGitHubLogin = target.show_github_login;

  const showGitHubLogin = () => {
    setGitHubLoginVisible(true, target);
    target.console.info("GitHub login button is now visible.");
    return true;
  };

  target.show_github_login = showGitHubLogin;

  return () => {
    if (originalShowGitHubLogin === undefined) {
      delete target.show_github_login;
      return;
    }

    target.show_github_login = originalShowGitHubLogin;
  };
};

export const useGitHubLoginVisibility = () => {
  const [visible, setVisible] = useState(() => isGitHubLoginVisible());

  useEffect(() => {
    const syncVisibility = () => {
      setVisible(isGitHubLoginVisible());
    };

    syncVisibility();
    window.addEventListener(GITHUB_LOGIN_VISIBILITY_EVENT, syncVisibility);
    return () => {
      window.removeEventListener(GITHUB_LOGIN_VISIBILITY_EVENT, syncVisibility);
    };
  }, []);

  return visible;
};
