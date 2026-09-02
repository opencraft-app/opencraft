import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import sharp from "sharp";

const ASSET_PREFIX = "/lightvela-intl-home/assets/";
const FRAGMENT_FILE_PATTERN = /^index-fragment(?:\..+)?\.html$/;

function optimizedAvatarName(sourceName) {
  if (/-64\.webp$/i.test(sourceName)) return sourceName;
  return `${path.basename(sourceName, path.extname(sourceName))}-64.webp`;
}

function localAssetPath(homeRoot, source) {
  if (!source.startsWith(ASSET_PREFIX)) return null;
  const relativePath = source.slice(ASSET_PREFIX.length).split(/[?#]/, 1)[0];
  const resolved = path.resolve(homeRoot, "assets", relativePath);
  const assetsRoot = `${path.resolve(homeRoot, "assets")}${path.sep}`;
  return resolved.startsWith(assetsRoot) ? resolved : null;
}

export async function optimizeInternationalHomeVoiceAvatars(homeRoot) {
  const resolvedHomeRoot = path.resolve(homeRoot);
  const fragmentNames = (await readdir(resolvedHomeRoot))
    .filter((name) => FRAGMENT_FILE_PATTERN.test(name))
    .sort();
  const avatars = new Map();

  for (const fragmentName of fragmentNames) {
    const fragmentPath = path.join(resolvedHomeRoot, fragmentName);
    const html = await readFile(fragmentPath, "utf8");
    const dom = new JSDOM(html);
    const voiceImages = Array.from(dom.window.document.querySelectorAll(".voice .tcard img"));
    let rewrittenHtml = html;

    for (const image of voiceImages) {
      const source = image.getAttribute("src") ?? "";
      const sourcePath = localAssetPath(resolvedHomeRoot, source);
      if (!sourcePath) continue;

      const sourceName = path.basename(sourcePath);
      const outputName = optimizedAvatarName(sourceName);
      const outputPath = path.join(resolvedHomeRoot, "assets", outputName);
      if (!avatars.has(sourcePath)) avatars.set(sourcePath, outputPath);

      const originalMarkup = image.outerHTML;
      image.setAttribute("src", `${ASSET_PREFIX}${outputName}`);
      image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
      image.setAttribute("width", "32");
      image.setAttribute("height", "32");
      rewrittenHtml = rewrittenHtml.replaceAll(originalMarkup, image.outerHTML);
    }

    if (rewrittenHtml !== html) await writeFile(fragmentPath, rewrittenHtml);
  }

  let sourceBytes = 0;
  let optimizedBytes = 0;
  for (const [sourcePath, outputPath] of avatars) {
    const sourceSize = (await stat(sourcePath)).size;
    sourceBytes += sourceSize;

    if (sourcePath !== outputPath) {
      await sharp(sourcePath, { animated: false })
        .resize(64, 64, { fit: "cover", position: "centre" })
        .webp({ quality: 82, effort: 5 })
        .toFile(outputPath);
    }
    optimizedBytes += (await stat(outputPath)).size;
  }

  return {
    avatars: avatars.size,
    sourceBytes,
    optimizedBytes,
    fragments: fragmentNames.length,
  };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const homeRoot = process.argv[2];
  if (!homeRoot) {
    throw new Error(
      "Usage: node scripts/international-home-voice-avatars.mjs <international-home-root>",
    );
  }
  const summary = await optimizeInternationalHomeVoiceAvatars(homeRoot);
  console.log(
    `[international-home-voice-avatars] optimized ${summary.avatars} avatar(s) across ${summary.fragments} fragment(s): ${summary.sourceBytes} -> ${summary.optimizedBytes} bytes`,
  );
}
