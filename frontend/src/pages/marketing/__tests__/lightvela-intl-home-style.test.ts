import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const intlHomeStyles = readFileSync(
  join(process.cwd(), "public/lightvela-intl-home/style.css"),
  "utf8",
);

describe("LightVela international home styles", () => {
  it("self-hosts a stable signature font for the footer display text", () => {
    expect(intlHomeStyles).toContain("font-family: 'Allura'");
    expect(intlHomeStyles).toContain("src: url('assets/fonts/allura-latin.woff2') format('woff2');");
    expect(intlHomeStyles).toContain(
      "--font-footer-display: 'Allura', Georgia, 'Times New Roman', serif;",
    );
  });

  it("rotates the capability strip copy with a two-second reading hold", () => {
    expect(intlHomeStyles).toContain("--soul-strip-hold: 2s;");
    expect(intlHomeStyles).toContain(".soul-strip__cap--secondary");
    expect(intlHomeStyles).toContain(".soul-strip__icons--secondary");
    expect(intlHomeStyles).toContain(".soul-strip__state--secondary");
    expect(intlHomeStyles).toMatch(/\.soul-strip__half > \.soul-strip__cap:not\(\.soul-strip__cap--secondary\)\s*\{[^}]*animation:\s*soul-strip-primary/s);
    expect(intlHomeStyles).toMatch(/\.soul-strip__cap--secondary\s*\{[^}]*animation:\s*soul-strip-secondary/s);
    expect(intlHomeStyles).toMatch(/\.soul-strip__cap--secondary\s*\{[^}]*position:\s*absolute;/s);
    expect(intlHomeStyles).toMatch(/\.soul-strip__state--secondary\s*\{[^}]*justify-content:\s*flex-start;/s);
    expect(intlHomeStyles).not.toMatch(/\.soul-strip__copy--right \.soul-strip__state--secondary\s*\{[^}]*flex-direction:\s*row-reverse;/s);
    expect(intlHomeStyles).not.toMatch(/\.soul-strip__copy--right \.soul-strip__state--secondary b\s*\{[^}]*text-align:\s*right;/s);
    expect(intlHomeStyles).toMatch(/\.soul-strip__state--secondary \.soul-strip__label\s*\{[^}]*font-weight:\s*400;/s);
    expect(intlHomeStyles).toMatch(/\.soul-strip__state--secondary b\s*\{[^}]*font-size:\s*16px;[^}]*color:\s*#000;[^}]*white-space:\s*nowrap;/s);
    expect(intlHomeStyles).toContain("@keyframes soul-strip-primary");
    expect(intlHomeStyles).toContain("@keyframes soul-strip-sweep");
    expect(intlHomeStyles).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
