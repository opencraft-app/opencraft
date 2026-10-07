import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pngjs from 'pngjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = pngjs.PNG.sync.read(readFileSync(resolve(root, 'assets/lightvela-icon.png')));
if (source.width !== 736 || source.height !== 736) {
  throw new Error('Unexpected LightVela icon size; review the login mark before regenerating.');
}

// 368 px covers the 106 pt login mark at iPhone 3x density.
const size = 368;
const resized = new pngjs.PNG({ width: size, height: size });
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const target = (y * size + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          sum += source.data[((y * 2 + dy) * source.width + x * 2 + dx) * 4 + channel];
        }
      }
      resized.data[target + channel] = Math.round(sum / 4);
    }
  }
}
const png = pngjs.PNG.sync.write(resized, { compressionLevel: 9 });
const output = `// Generated from assets/lightvela-icon.png by scripts/generate-login-mark.mjs.\n` +
  `// Inlining the first-screen mark avoids a second Metro asset request in Expo Go.\n` +
  `export const lightVelaLoginMark = "data:image/png;base64,${png.toString('base64')}";\n`;
writeFileSync(resolve(root, 'src/assets/lightvela-login-mark.ts'), output);
console.log(`Wrote first-screen mark (${png.length} PNG bytes).`);
