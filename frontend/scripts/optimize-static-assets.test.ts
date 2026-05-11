import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { optimizeStaticAssets } from "./optimize-static-assets.mjs";

async function writePng(filePath: string) {
  const image = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 120, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await writeFile(filePath, image);
}

async function writeJpeg(filePath: string) {
  const image = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 0, g: 80, b: 200 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  await writeFile(filePath, image);
}

describe("optimizeStaticAssets", () => {
  it("keeps originals, writes webp siblings, and rewrites only local artifact references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asset-optimize-"));
    await writePng(path.join(root, "hero.png"));
    await writeJpeg(path.join(root, "nested-card.jpg"));

    await writeFile(
      path.join(root, "index.html"),
      [
        '<img src="/hero.png">',
        '<img src="https://cdn.example.com/remote.png">',
        '<img src="https://cdn.example.com/hero.png">',
        '<img src="data:image/png;base64,abcd">',
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "style.css"),
      ".hero{background:url('/hero.png?v=1#top')} .card{background:url(./nested-card.jpg)}",
    );
    await writeFile(
      path.join(root, "app.js"),
      [
        "const localImage = \"/hero.png\";",
        "const wrappedImage = assetUrl(\"/hero.png\");",
        "const minifiedWrappedImage = Jn(\"/nested-card.jpg\");",
      ].join("\n"),
    );

    const beforeHero = (await stat(path.join(root, "hero.png"))).size;
    const summary = await optimizeStaticAssets(root, { log: () => undefined });
    const html = await readFile(path.join(root, "index.html"), "utf8");
    const css = await readFile(path.join(root, "style.css"), "utf8");
    const js = await readFile(path.join(root, "app.js"), "utf8");

    expect(existsSync(path.join(root, "hero.png"))).toBe(true);
    expect(existsSync(path.join(root, "hero.webp"))).toBe(true);
    expect(existsSync(path.join(root, "nested-card.webp"))).toBe(true);
    expect((await stat(path.join(root, "hero.png"))).size).toBeLessThanOrEqual(beforeHero);
    expect(html).toContain('src="/hero.webp"');
    expect(html).toContain('src="https://cdn.example.com/remote.png"');
    expect(html).toContain('src="https://cdn.example.com/hero.png"');
    expect(html).toContain('src="data:image/png;base64,abcd"');
    expect(css).toContain("url('/hero.webp?v=1#top')");
    expect(css).toContain("url(./nested-card.webp)");
    expect(js).toContain('const localImage = "/hero.webp";');
    expect(js).toContain('const wrappedImage = assetUrl("/hero.webp");');
    expect(js).toContain('const minifiedWrappedImage = Jn("/nested-card.webp");');
    expect(summary.webpWritten).toBe(2);
    expect(summary.referenceRewrites).toBe(6);
  });
});
