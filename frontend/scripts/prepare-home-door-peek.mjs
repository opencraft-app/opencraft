import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const assets = new URL('../public/lightvela-intl-home/assets/', import.meta.url);
const { data: source, info } = await sharp(fileURLToPath(new URL('hermes-door.webp', assets))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
assert.equal(info.width, 964);
assert.equal(info.height, 966);
// Re-run this script whenever hermes-door.webp changes; these values are tuned to its 964×966 source pixels.
const region = { left: 374, top: 430, width: 128, height: 244 };
const verticalSampleRadius = 3;
const plate = Buffer.from(source);
const character = Buffer.alloc(region.width * region.height * 4);
const smooth = (value) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const sample = (x, y, channel) => {
  let sum = 0;
  let count = 0;
  for (let dy = -verticalSampleRadius; dy <= verticalSampleRadius; dy++) {
    const sampleY = y + dy;
    if (x < 0 || x >= info.width || sampleY < 0 || sampleY >= info.height) continue;
    sum += source[(sampleY * info.width + x) * 3 + channel];
    count++;
  }
  return count === 0 ? 0 : sum / count;
};

for (let y = 0; y < region.height; y++) {
  for (let x = 0; x < region.width; x++) {
    const globalX = region.left + x;
    const globalY = region.top + y;
    const index = (globalY * info.width + globalX) * 3;
    const output = (y * region.width + x) * 4;
    const weight = smooth(y / 14) * smooth((region.height - 1 - y) / 14) * smooth((region.width - 1 - x) / 20);
    const background = [0, 1, 2].map((channel) => {
      const above = sample(globalX, region.top - 5, channel);
      const below = sample(globalX, region.top + region.height + 5, channel);
      const estimate = above + (below - above) * y / (region.height - 1);
      const value = Math.round(source[index + channel] * (1 - weight) + estimate * weight);
      plate[index + channel] = value;
      return value;
    });
    let alpha = 0;
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = source[index + channel] - background[channel];
      difference = Math.max(difference, Math.abs(delta));
      alpha = Math.max(alpha, delta < 0 ? -delta / Math.max(1, background[channel]) : delta / Math.max(1, 255 - background[channel]));
    }
    alpha = Math.min(1, Math.max(alpha, smooth((difference - 2) / 60)));
    character[output + 3] = Math.ceil(alpha * 255);
    const actualAlpha = character[output + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      character[output + channel] = actualAlpha ? Math.round(background[channel] + (source[index + channel] - background[channel]) / actualAlpha) : 0;
    }
  }
}

await sharp(plate, { raw: info }).webp({ lossless: true }).toFile(fileURLToPath(new URL('hermes-door-background.webp', assets)));
await sharp(character, { raw: { width: region.width, height: region.height, channels: 4 } }).webp({ lossless: true }).toFile(fileURLToPath(new URL('hermes-door-character.webp', assets)));
console.log('Prepared fixed door background and transparent character:', region);
