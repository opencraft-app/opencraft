import { afterEach, describe, expect, it, vi } from "vitest";
import { installShowGitHubLoginHelper, isGitHubLoginVisible, setGitHubLoginVisible } from "@/lib/github-login-visibility";

describe("github login visibility helper", () => {
  afterEach(() => {
    delete (window as Window & typeof globalThis & { show_github_login?: unknown; __LIGHTVELA_SHOW_GITHUB_LOGIN__?: boolean }).show_github_login;
    delete (window as Window & typeof globalThis & { __LIGHTVELA_SHOW_GITHUB_LOGIN__?: boolean }).__LIGHTVELA_SHOW_GITHUB_LOGIN__;
    vi.restoreAllMocks();
  });

  it("keeps github login hidden by default", () => {
    expect(isGitHubLoginVisible()).toBe(false);
  });

  it("exposes show_github_login() and flips visibility on demand", () => {
    const infoSpy = vi.spyOn(window.console, "info").mockImplementation(() => undefined);

    const cleanup = installShowGitHubLoginHelper();

    expect(typeof window.show_github_login).toBe("function");
    expect((window.show_github_login as () => boolean)()).toBe(true);
    expect(isGitHubLoginVisible()).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith("GitHub login button is now visible.");

    cleanup();

    expect(window.show_github_login).toBeUndefined();
  });

  it("allows visibility to be toggled directly", () => {
    expect(setGitHubLoginVisible(true)).toBe(true);
    expect(isGitHubLoginVisible()).toBe(true);
    expect(setGitHubLoginVisible(false)).toBe(false);
    expect(isGitHubLoginVisible()).toBe(false);
  });
});
