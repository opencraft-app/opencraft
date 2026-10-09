import { velaFontAssets } from "./font-assets";
import { velaTheme } from "./tokens";

describe("Vela font assets", () => {
  it("loads every semantic font name used by the theme", () => {
    const bundledFontNames = [
      ...new Set(
        Object.values(velaTheme.semantic.typography).map(
          (style) => style.fontFamily,
        ),
      ),
    ]
      .filter((fontName) => fontName !== "System")
      .sort();
    expect(Object.keys(velaFontAssets).sort()).toEqual(bundledFontNames);
    expect(velaFontAssets).not.toHaveProperty("System");
  });
});
