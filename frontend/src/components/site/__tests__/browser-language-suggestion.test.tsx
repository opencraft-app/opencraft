import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isGlobal: true, hadSavedLocale: false }));
const setLocaleMock = vi.hoisted(() => vi.fn((locale: string) => {
  window.localStorage.setItem("lw-locale", locale);
}));

vi.mock("@/i18n", () => ({
  get hadSavedLocaleBeforeInitialPage() {
    return state.hadSavedLocale;
  },
  setLocale: setLocaleMock,
}));
vi.mock("@/lib/region", () => ({
  get isGlobal() {
    return state.isGlobal;
  },
  localizedPath: (_path: string, locale: string) => `/${locale.toLowerCase()}/`,
}));

import {
  BrowserLanguageSuggestion,
  suggestedLocaleForBrowserLanguage,
} from "../browser-language-suggestion";

function prefer(...languages: string[]) {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

beforeEach(() => {
  state.isGlobal = true;
  state.hadSavedLocale = false;
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  setLocaleMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("browser language suggestion", () => {
  it.each([
    ["zh-CN", "zh-SG"],
    ["zh-Hans-CN", "zh-SG"],
    ["zh-TW", "zh-Hant"],
    ["zh-Hant-HK", "zh-Hant"],
    ["es-MX", "es"],
    ["ja", "ja-JP"],
    ["ko-KR", "ko-KR"],
    ["id", "id-ID"],
    ["en-GB", null],
    ["fr-FR", null],
    ["invalid_tag_!", null],
  ])("maps browser language %s to %s", (language, expected) => {
    expect(suggestedLocaleForBrowserLanguage(language)).toBe(expected);
  });

  it("suggests the international simplified Chinese URL once on the bare English home", async () => {
    prefer("zh-CN", "en-US");

    const view = render(<BrowserLanguageSuggestion />);

    const link = await screen.findByRole("link", { name: "Switch to 简体中文" });
    expect(link).toHaveAttribute("href", "/zh-sg/");
    expect(window.localStorage.getItem("lw-language-suggestion-seen")).toBe("1");

    view.unmount();
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("link", { name: "Switch to 简体中文" })).not.toBeInTheDocument();
  });

  it("continues in English and saves the choice", async () => {
    prefer("zh-CN");
    render(<BrowserLanguageSuggestion />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue in English" }));

    expect(setLocaleMock).toHaveBeenCalledWith("en-US");
    expect(window.localStorage.getItem("lw-locale")).toBe("en-US");
    expect(screen.queryByRole("button", { name: "Continue in English" })).not.toBeInTheDocument();
  });

  it("uses the existing locale setter when switching to Chinese", async () => {
    prefer("zh-CN");
    render(<BrowserLanguageSuggestion />);

    fireEvent.click(await screen.findByRole("link", { name: "Switch to 简体中文" }));

    expect(setLocaleMock).toHaveBeenCalledWith("zh-CN");
  });

  it("does not prompt on a localized URL, the domestic site, or after an earlier choice", async () => {
    prefer("zh-CN");
    window.history.replaceState(null, "", "/zh-sg/");
    const view = render(<BrowserLanguageSuggestion />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Language suggestion" })).not.toBeInTheDocument());

    view.unmount();
    window.history.replaceState(null, "", "/");
    state.isGlobal = false;
    const domestic = render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region", { name: "Language suggestion" })).not.toBeInTheDocument();

    domestic.unmount();
    state.isGlobal = true;
    state.hadSavedLocale = true;
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region", { name: "Language suggestion" })).not.toBeInTheDocument();
  });

  it("treats a cleared private-browsing store as a new visit", async () => {
    prefer("zh-CN");
    const first = render(<BrowserLanguageSuggestion />);
    expect(await screen.findByRole("region", { name: "Language suggestion" })).toBeInTheDocument();

    first.unmount();
    window.localStorage.clear();
    render(<BrowserLanguageSuggestion />);
    expect(await screen.findByRole("region", { name: "Language suggestion" })).toBeInTheDocument();
  });

  it("uses only the browser's first language", async () => {
    prefer("fr-FR", "zh-CN");
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region", { name: "Language suggestion" })).not.toBeInTheDocument();
  });
});
