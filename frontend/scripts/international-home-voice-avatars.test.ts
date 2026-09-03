import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { optimizeInternationalHomeVoiceAvatars } from "./international-home-voice-avatars.mjs";

async function writePng(filePath: string, size: number, color: string) {
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toFile(filePath);
}

describe("optimizeInternationalHomeVoiceAvatars", () => {
  it("writes one 64px WebP per unique voice avatar and updates only voice cards", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "international-home-avatars-"));
    const assetsRoot = path.join(homeRoot, "assets");
    await mkdir(assetsRoot);
    await writePng(path.join(assetsRoot, "voice-test.png"), 128, "#6a4fde");
    await writePng(path.join(assetsRoot, "chat-avatar.png"), 48, "#22aa77");

    const fragment = [
      '<section class="voice"><article class="tcard">',
      '<img src="/lightvela-intl-home/assets/voice-test.png" alt="">',
      "</article></section>",
      '<div class="chat"><img src="/lightvela-intl-home/assets/chat-avatar.png" alt=""></div>',
    ].join("");
    await writeFile(path.join(homeRoot, "index-fragment.en-US.html"), fragment);
    await writeFile(path.join(homeRoot, "index-fragment.id-ID.html"), fragment);

    const sourceBytes = (await stat(path.join(assetsRoot, "voice-test.png"))).size;
    const summary = await optimizeInternationalHomeVoiceAvatars(homeRoot);
    const optimizedPath = path.join(assetsRoot, "voice-test-64.webp");
    const optimized = await sharp(optimizedPath).metadata();

    for (const locale of ["en-US", "id-ID"]) {
      const html = await readFile(path.join(homeRoot, `index-fragment.${locale}.html`), "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      const voiceAvatar = document.querySelector<HTMLImageElement>(".voice .tcard img");
      const chatAvatar = document.querySelector<HTMLImageElement>(".chat img");

      expect(voiceAvatar?.getAttribute("src")).toBe(
        "/lightvela-intl-home/assets/voice-test-64.webp",
      );
      expect(voiceAvatar?.getAttribute("loading")).toBe("lazy");
      expect(voiceAvatar?.getAttribute("decoding")).toBe("async");
      expect(voiceAvatar?.getAttribute("width")).toBe("32");
      expect(voiceAvatar?.getAttribute("height")).toBe("32");
      expect(chatAvatar?.getAttribute("src")).toBe(
        "/lightvela-intl-home/assets/chat-avatar.png",
      );
    }

    expect(optimized.width).toBe(64);
    expect(optimized.height).toBe(64);
    expect(summary).toEqual({
      avatars: 1,
      sourceBytes,
      optimizedBytes: (await stat(optimizedPath)).size,
      fragments: 2,
    });
  });
});
