import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlogShareActions } from "@/pages/marketing/blog-share-actions";

const writeText = vi.fn<(_: string) => Promise<void>>();

vi.mock("@/i18n/t", () => ({
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
});
