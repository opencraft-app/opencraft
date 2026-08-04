import { raftFontAssets } from "./font-assets";
import { raftTheme } from "./tokens";

describe("Raft font assets", () => {
  it("loads every semantic font name used by the theme", () => {
    const bundledFontNames = [
      ...new Set(
        Object.values(raftTheme.semantic.typography).map(
          (style) => style.fontFamily,
        ),
      ),
    ]
      .filter((fontName) => fontName !== "System")
      .sort();
    expect(Object.keys(raftFontAssets).sort()).toEqual(bundledFontNames);
    expect(raftFontAssets).not.toHaveProperty("System");
  });
});
