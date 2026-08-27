import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function getBlockBody(source: string, marker: string): string | undefined {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) return undefined;

  const blockStart = source.indexOf("{", markerStart);
  if (blockStart < 0) return undefined;

  let depth = 1;
  for (let index = blockStart + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(blockStart + 1, index);
  }

  return undefined;
}

describe("Agent settings navigation spacing", () => {
  it("uses compact desktop spacing and preserves mobile hit areas", () => {
    const desktopNavigation = getBlockBody(styles, "\n.lv-agents-nav {");
    const desktopItem = getBlockBody(styles, "\n.lv-agents-nav-item {");
    const responsiveStyles = getBlockBody(styles, "@media (max-width: 1023px) {");
    const mobileNavigation = getBlockBody(responsiveStyles ?? "", "\n  .lv-agents-nav {");
    const mobileItem = getBlockBody(responsiveStyles ?? "", "\n  .lv-agents-nav-item {");

    expect(desktopNavigation).toContain("gap: 8px;");
    expect(desktopItem).toContain("height: 32px;");
    expect(mobileNavigation).toContain("gap: 12px;");
    expect(mobileItem).toContain("height: 36px;");
  });
});
