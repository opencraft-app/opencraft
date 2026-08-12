import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { LocaleOverrideProvider } from "@/i18n/t";
import FeatureSection, { CardsSection } from "../FeatureSection";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FeatureSection route locale", () => {
  it("renders marquee tags from the route locale instead of the global i18n language", () => {
    render(
      <LocaleOverrideProvider locale="en-US">
        <FeatureSection />
      </LocaleOverrideProvider>,
    );

    expect(screen.getAllByText("Marketing").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("市场营销")).toHaveLength(0);
  });

  it("renders card copy from the route locale instead of the global i18n language", () => {
    render(
      <LocaleOverrideProvider locale="en-US">
        <CardsSection />
      </LocaleOverrideProvider>,
    );

    expect(
      screen.getByRole("heading", {
        name: "A cloud-native Hermes Agent experience",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Authentic Hermes Agent, ready in one click"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Hermes Agent 云端原生体验")).not.toBeInTheDocument();
    expect(screen.queryByText("原版 Hermes Agent，一键即用")).not.toBeInTheDocument();
  });
});
