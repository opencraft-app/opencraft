import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';

// Optimize copied delivery images, leaving the mechanically mirrored source
// assets untouched. Preserve formats/URLs and never enlarge the output file.
export async function optimizeWebImages(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { before: 0, after: 0 }; throw error; }
  let before = 0; let after = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) continue;
    const file = join(root, entry.name); const input = await readFile(file);
    const image = sharp(input).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true });
    const output = await (extension === '.png' ? image.png({ compressionLevel: 9 })
      : extension === '.webp' ? image.webp({ quality: 78 }) : image.jpeg({ quality: 78, mozjpeg: true })).toBuffer();
    before += input.length;
    if (output.length < input.length) { await writeFile(file, output); after += output.length; }
    else after += input.length;
  }
  return { before, after };
}
