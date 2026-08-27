import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleOverrideProvider } from "@/i18n/t";
import ProcessSection from "@/imports/Frame2147230025/sections/ProcessSection";

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProcessSection Spanish localization", () => {
  it("renders Spanish step labels on desktop and mobile", () => {
    render(
      <LocaleOverrideProvider locale="es">
        <ProcessSection />
      </LocaleOverrideProvider>,
    );

    expect(screen.getAllByText("Paso 1")).toHaveLength(2);
    expect(screen.getAllByText("Paso 2")).toHaveLength(2);
    expect(screen.getAllByText("Paso 3")).toHaveLength(2);
    expect(screen.queryByText("Step 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Step 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Step 3")).not.toBeInTheDocument();
  });
});
