import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const appRoot = new URL("..", import.meta.url).pathname;
const buildDir = join(appRoot, "build");
const sourcePng = join(buildDir, "lightvela-icon.png");
const iconsetDir = join(buildDir, "icon.iconset");

const entries = [
  [16, "icon_16x16.png", true],
  [32, "icon_16x16@2x.png", true],
  [32, "icon_32x32.png", true],
  [64, "icon_32x32@2x.png", true],
  [128, "icon_128x128.png", false],
  [256, "icon_128x128@2x.png", false],
  [256, "icon_256x256.png", false],
  [512, "icon_256x256@2x.png", false],
  [512, "icon_512x512.png", false],
  [1024, "icon_512x512@2x.png", false],
];

await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });

const smallSource = sharp(sourcePng)
  .extract({ left: 120, top: 120, width: 496, height: 496 })
  .modulate({ saturation: 0.98, brightness: 1.01 });

for (const [size, filename, small] of entries) {
  const image = small ? smallSource.clone() : sharp(sourcePng);
  await image
    .resize(size, size, {
      fit: "cover",
      kernel: small ? sharp.kernel.lanczos3 : sharp.kernel.lanczos3,
    })
    .png({ compressionLevel: 9 })
    .toFile(join(iconsetDir, filename));
}

execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", join(buildDir, "icon.icns")], {
  stdio: "inherit",
});
await rm(iconsetDir, { recursive: true, force: true });
