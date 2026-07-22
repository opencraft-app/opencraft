import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageSwitcher } from "@/components/site/language-switcher";
import { isGlobal } from "@/lib/region";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LanguageSwitcher", () => {
  it("keeps each region's site menu labels and order", () => {
    render(<LanguageSwitcher activeLocale={isGlobal ? "en-US" : "zh-CN"} />);

    fireEvent.click(screen.getByRole("button", { name: "Change language" }));

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      isGlobal
        ? ["International Site - English", "International Site - 中文", "China Site"]
        : ["中国站", "国际站 - 中文", "国际站 - English"],
    );
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("opens cross-site destinations in a new browser window", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<LanguageSwitcher activeLocale={isGlobal ? "en-US" : "zh-CN"} />);

    fireEvent.click(screen.getByRole("button", { name: "Change language" }));
    fireEvent.click(screen.getByRole("option", { name: isGlobal ? "China Site" : "国际站 - 中文" }));

    expect(openSpy).toHaveBeenCalledWith(
      isGlobal ? "https://lightvela.com" : "https://lightvela.ai/zh-sg/",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
