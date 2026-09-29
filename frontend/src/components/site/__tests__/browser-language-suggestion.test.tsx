import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isGlobal: true, hadExplicitLocale: false }));
const setLocaleMock = vi.hoisted(() => vi.fn((locale: string) => {
  window.localStorage.setItem("lw-locale", locale);
  window.localStorage.setItem("lw-locale-explicit", "1");
}));

vi.mock("@/i18n", () => ({
  hasExplicitLocalePreference: () =>
    state.hadExplicitLocale || window.localStorage.getItem("lw-locale-explicit") === "1",
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
  state.hadExplicitLocale = false;
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

    const link = await screen.findByRole("link", { name: "切换到简体中文" });
    expect(link).toHaveAttribute("href", "/zh-sg/");
    expect(screen.getByRole("region", { name: "语言切换建议" })).toHaveAttribute("lang", "zh-SG");
    expect(window.localStorage.getItem("lw-language-suggestion-seen")).toBe("1");

    view.unmount();
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("link", { name: "切换到简体中文" })).not.toBeInTheDocument();
  });

  it.each(["继续使用英语", "关闭并继续使用英语"])("%s saves the English choice", async (buttonLabel) => {
    prefer("zh-CN");
    const view = render(<BrowserLanguageSuggestion />);

    fireEvent.click(await screen.findByRole("button", { name: buttonLabel }));

    expect(setLocaleMock).toHaveBeenCalledWith("en-US");
    expect(window.localStorage.getItem("lw-locale")).toBe("en-US");
    expect(window.localStorage.getItem("lw-locale-explicit")).toBe("1");
    expect(screen.queryByRole("button", { name: "继续使用英语" })).not.toBeInTheDocument();

    view.unmount();
    window.localStorage.removeItem("lw-language-suggestion-seen");
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("uses the existing locale setter when switching to Chinese", async () => {
    prefer("zh-CN");
    render(<BrowserLanguageSuggestion />);

    fireEvent.click(await screen.findByRole("link", { name: "切换到简体中文" }));

    expect(setLocaleMock).toHaveBeenCalledWith("zh-CN");
  });

  it.each([
    ["ja-JP", "言語切り替えの提案", "日本語に切り替える"],
    ["ko-KR", "언어 전환 제안", "한국어로 전환"],
    ["es-ES", "Sugerencia de idioma", "Cambiar a español"],
  ])("presents %s visitors with a readable suggestion", async (language, label, switchLabel) => {
    prefer(language);
    render(<BrowserLanguageSuggestion />);

    expect(await screen.findByRole("region", { name: label })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: switchLabel })).toBeInTheDocument();
  });

  it("does not prompt on a localized URL, the domestic site, or after an earlier choice", async () => {
    prefer("zh-CN");
    window.history.replaceState(null, "", "/zh-sg/");
    const view = render(<BrowserLanguageSuggestion />);
    await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());

    view.unmount();
    window.history.replaceState(null, "", "/");
    state.isGlobal = false;
    const domestic = render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    domestic.unmount();
    state.isGlobal = true;
    state.hadExplicitLocale = true;
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("treats a cleared private-browsing store as a new visit", async () => {
    prefer("zh-CN");
    const first = render(<BrowserLanguageSuggestion />);
    expect(await screen.findByRole("region", { name: "语言切换建议" })).toBeInTheDocument();

    first.unmount();
    window.localStorage.clear();
    render(<BrowserLanguageSuggestion />);
    expect(await screen.findByRole("region", { name: "语言切换建议" })).toBeInTheDocument();
  });

  it("uses only the browser's first language", async () => {
    prefer("fr-FR", "zh-CN");
    render(<BrowserLanguageSuggestion />);
    expect(screen.queryByRole("region", { name: "语言切换建议" })).not.toBeInTheDocument();
  });
});
