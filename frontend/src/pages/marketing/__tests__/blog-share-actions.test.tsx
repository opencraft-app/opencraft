import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlogShareActions } from "@/pages/marketing/blog-share-actions";

const writeText = vi.fn<(_: string) => Promise<void>>();
const regionState = vi.hoisted(() => ({ isGlobal: true }));

vi.mock("@/lib/region", () => ({
  get isGlobal() {
    return regionState.isGlobal;
  },
}));

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
  useT: () => (text: string) => {
    const translations: Record<string, string> = {
      "分享": "Share",
      "复制链接": "Copy link",
      "已复制": "Copied",
    };
    return translations[text] ?? text;
  },
}));

describe("BlogShareActions", () => {
  beforeEach(() => {
    regionState.isGlobal = true;
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the canonical article link and builds share URLs from the title and link", async () => {
    render(<BlogShareActions path="/blog/hermes" title="Hermes article" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://lightvela.ai/blog/hermes");
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Share" }).parentElement).toHaveClass("justify-between");
    expect(screen.getByRole("button", { name: "Copied" })).not.toHaveClass("size-9");
    expect(screen.getByRole("link", { name: "Share X" })).toHaveClass("size-9");
    expect(screen.getByRole("link", { name: "Share X" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Share LinkedIn" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Share Facebook" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Share X" })).toHaveAttribute(
      "href",
      expect.stringContaining("Hermes%20article%0Ahttps%3A%2F%2Flightvela.ai%2Fblog%2Fhermes"),
    );
    expect(screen.getByRole("link", { name: "Share LinkedIn" })).toHaveAttribute(
      "href",
      expect.stringContaining("https%3A%2F%2Flightvela.ai%2Fblog%2Fhermes"),
    );
    expect(screen.getByRole("link", { name: "Share Facebook" })).toHaveAttribute(
      "href",
      expect.stringContaining("https%3A%2F%2Flightvela.ai%2Fblog%2Fhermes"),
    );
  });

  it("keeps only the copy-link control on the domestic Blog", () => {
    regionState.isGlobal = false;

    const { container } = render(<BlogShareActions path="/blog/hermes" title="Hermes article" />);

    expect(within(container).getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(within(container).queryByRole("link", { name: "Share X" })).not.toBeInTheDocument();
    expect(within(container).queryByRole("link", { name: "Share LinkedIn" })).not.toBeInTheDocument();
    expect(within(container).queryByRole("link", { name: "Share Facebook" })).not.toBeInTheDocument();
  });
});
