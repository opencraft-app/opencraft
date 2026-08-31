import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildInternationalSiteUrl,
  buildLanguageSwitcherOptions,
  LanguageSwitcher,
} from "@/components/site/language-switcher";
import { isGlobal } from "@/lib/region";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("LanguageSwitcher", () => {
  it("keeps each region's site menu labels and order", () => {
    render(<LanguageSwitcher activeLocale={isGlobal ? "en-US" : "zh-CN"} />);

    fireEvent.click(screen.getByRole("button", { name: "Change language" }));

    expect(screen.getByRole("listbox")).toHaveClass("w-max");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      isGlobal
        ? [
            "International Site - English",
            "International Site - 简体中文",
            "International Site - 繁體中文",
            "International Site - Bahasa Indonesia",
            "International Site - Español",
            "中国站",
          ]
        : ["中国站", "国际站 - 简体中文", "国际站 - English"],
    );
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options.map((option) => option.textContent)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("日本語"),
        expect.stringContaining("한국어"),
      ]),
    );

    if (isGlobal) {
      cleanup();
      render(<LanguageSwitcher activeLocale="zh-SG" />);
      fireEvent.click(screen.getByRole("button", { name: "Change language" }));
      expect(screen.getAllByRole("option").at(-1)).toHaveTextContent("中国站");
    }
  });

  it("builds an explicit Spanish option fixture from the locale registry", () => {
    expect(buildLanguageSwitcherOptions(["en-US", "es"], "International Site")).toEqual([
      { value: "en-US", short: "EN", label: "International Site - English" },
      { value: "es", short: "ES", label: "International Site - Español" },
    ]);
  });

  it("builds a release-ready Japanese option from the locale registry", () => {
    expect(buildLanguageSwitcherOptions(["en-US", "ja-JP"], "International Site")).toEqual([
      { value: "en-US", short: "EN", label: "International Site - English" },
      { value: "ja-JP", short: "JA", label: "International Site - 日本語" },
    ]);
  });

  it("closes the desktop listbox with Escape and restores trigger focus", () => {
    render(<LanguageSwitcher activeLocale={isGlobal ? "en-US" : "zh-CN"} />);
    const trigger = screen.getByRole("button", { name: "Change language" });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("adds Spanish to the global production menu while keeping Japanese and Korean hidden", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    const { LanguageSwitcher: GlobalLanguageSwitcher } = await import(
      "@/components/site/language-switcher"
    );

    render(<GlobalLanguageSwitcher activeLocale="en-US" />);
    fireEvent.click(screen.getByRole("button", { name: "Change language" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "International Site - English",
      "International Site - 简体中文",
      "International Site - 繁體中文",
      "International Site - Bahasa Indonesia",
      "International Site - Español",
      "中国站",
    ]);
    expect(screen.getByRole("option", { name: "International Site - Español" })).toBeInTheDocument();
    expect(screen.queryByText(/日本語|한국어/)).not.toBeInTheDocument();
  });

  it("adds Japanese to the explicit global development preview menu", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_LOCALES", "ja-JP");
    const { LanguageSwitcher: PreviewLanguageSwitcher } = await import(
      "@/components/site/language-switcher"
    );

    render(<PreviewLanguageSwitcher activeLocale="en-US" />);
    fireEvent.click(screen.getByRole("button", { name: "Change language" }));

    expect(screen.getByRole("option", {
      name: "International Site - 日本語",
    })).toBeInTheDocument();
    expect(screen.queryByText(/한국어/)).not.toBeInTheDocument();
  });

  it("builds Spanish and English international URLs while preserving the public path", () => {
    expect(buildInternationalSiteUrl("es", { pathname: "/zh-hant/about", search: "", hash: "" })).toBe(
      "https://lightvela.ai/es/about",
    );
    expect(buildInternationalSiteUrl("en-US", { pathname: "/es/about", search: "?from=nav", hash: "#team" })).toBe(
      "https://lightvela.ai/about?from=nav#team",
    );
    expect(buildInternationalSiteUrl("es", { pathname: "/agents", search: "?tab=chat", hash: "" })).toBe(
      "https://lightvela.ai/agents?tab=chat",
    );
  });

  it("opens cross-site destinations in a new browser window", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<LanguageSwitcher activeLocale={isGlobal ? "en-US" : "zh-CN"} />);

    fireEvent.click(screen.getByRole("button", { name: "Change language" }));
    fireEvent.click(screen.getByRole("option", { name: isGlobal ? "中国站" : "国际站 - 简体中文" }));

    expect(openSpy).toHaveBeenCalledWith(
      isGlobal ? "https://lightvela.com" : "https://lightvela.ai/zh-sg/",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
