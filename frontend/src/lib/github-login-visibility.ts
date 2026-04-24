import { useEffect, useState } from "react";

const GITHUB_LOGIN_VISIBILITY_EVENT = "lightvela:github-login-visibility";

type GitHubLoginVisibilityHost = Window & typeof globalThis & {
  show_github_login?: unknown;
  __LIGHTVELA_SHOW_GITHUB_LOGIN__?: boolean;
};

export const isGitHubLoginVisible = (host: GitHubLoginVisibilityHost = window) => host.__LIGHTVELA_SHOW_GITHUB_LOGIN__ === true;

export const setGitHubLoginVisible = (visible: boolean, host: GitHubLoginVisibilityHost = window) => {
  host.__LIGHTVELA_SHOW_GITHUB_LOGIN__ = visible;
  host.dispatchEvent(new CustomEvent<boolean>(GITHUB_LOGIN_VISIBILITY_EVENT, { detail: visible }));
  return visible;
};

export const installShowGitHubLoginHelper = (host: GitHubLoginVisibilityHost = window) => {
  const originalShowGitHubLogin = host.show_github_login;

  const showGitHubLogin = () => {
    setGitHubLoginVisible(true, host);
    host.console.info("GitHub login button is now visible.");
    return true;
  };

  host.show_github_login = showGitHubLogin;

  return () => {
    if (originalShowGitHubLogin === undefined) {
      delete host.show_github_login;
      return;
    }

    host.show_github_login = originalShowGitHubLogin;
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
