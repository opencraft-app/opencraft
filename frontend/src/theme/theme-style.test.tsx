import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeStyleInjector } from "@/theme/theme-style";
import { activeThemePreset } from "@/theme/preset";

describe("ThemeStyleInjector", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
  });

  it("restores root theme mutations when unmounted", () => {
    document.documentElement.style.setProperty("--text-primary", "rebeccapurple");
    document.documentElement.dataset.theme = "existing";

    const { unmount } = render(<ThemeStyleInjector />);

    expect(document.documentElement.dataset.theme).toBe(activeThemePreset.id);
    expect(document.documentElement.style.getPropertyValue("--text-primary")).toBe(activeThemePreset.variables["--text-primary"]);

    unmount();

    expect(document.documentElement.dataset.theme).toBe("existing");
    expect(document.documentElement.style.getPropertyValue("--text-primary")).toBe("rebeccapurple");
    expect(document.documentElement.style.getPropertyValue("--brand-500")).toBe("");
  });
});
