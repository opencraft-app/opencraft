import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Next dev chrome boundary", () => {
  it("disables the Next dev indicator because it overlays embedded desktop shells", () => {
    const config = readFileSync(join(root, "next.config.mjs"), "utf8");

    expect(config).toMatch(/devIndicators\s*:\s*false/);
  });
});
