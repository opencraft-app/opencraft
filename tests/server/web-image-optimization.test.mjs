import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { optimizeWebImages } from '../../scripts/optimize-web-images.mjs';

async function directory(context) {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-image-delivery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('delivery optimization preserves PNG pixels, alpha, filenames and unrelated files', async (context) => {
  const root = await directory(context);
  const pixels = Buffer.alloc(96 * 48 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 37; pixels[offset + 1] = 109; pixels[offset + 2] = 211;
    pixels[offset + 3] = (offset / 4) % 3 === 0 ? 0 : (offset / 4) % 3 === 1 ? 128 : 255;
  }
  const input = await sharp(pixels, { raw: { width: 96, height: 48, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  await writeFile(join(root, 'transparent.png'), input);
  await writeFile(join(root, 'keep.svg'), '<svg/>');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'untouched.png'), input);
  const result = await optimizeWebImages(root);
  const output = await readFile(join(root, 'transparent.png'));
  assert.equal(result.before, input.length);
  assert.equal(result.after, output.length);
  assert.ok(output.length <= input.length);
  const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 96);
  assert.equal(decoded.info.height, 48);
  assert.equal(decoded.info.channels, 4);
  assert.deepEqual(decoded.data, pixels);
  assert.equal(await readFile(join(root, 'keep.svg'), 'utf8'), '<svg/>');
  assert.deepEqual(await readFile(join(root, 'nested', 'untouched.png')), input);
});

test('delivery keeps JPEG/WebP formats and constrains oriented large images without enlarging bytes', async (context) => {
  const root = await directory(context);
  const raw = Buffer.alloc(1920 * 960 * 3);
  // A deterministic high-entropy source makes the lossy delivery encoding
  // smaller; simple gradients can legitimately keep the original WebP bytes.
  let state = 0x12345678;
  for (let offset = 0; offset < raw.length; offset += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    raw[offset] = state >>> 24;
  }
  const source = () => sharp(raw, { raw: { width: 1920, height: 960, channels: 3 } });
  const jpeg = await source().withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
  const webp = await source().webp({ lossless: true }).toBuffer();
  await writeFile(join(root, 'rotated.jpg'), jpeg);
  await writeFile(join(root, 'large.webp'), webp);
  const result = await optimizeWebImages(root);
  assert.equal(result.before, jpeg.length + webp.length);
  let total = 0;
  for (const [name, original, format, width, height] of [
    ['rotated.jpg', jpeg, 'jpeg', 640, 1280],
    ['large.webp', webp, 'webp', 1280, 640],
  ]) {
    const output = await readFile(join(root, name));
    assert.ok(output.length < original.length);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, format);
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    assert.ok(!metadata.orientation || metadata.orientation === 1);
    total += output.length;
  }
  assert.equal(result.after, total);
});

test('delivery tolerates absent optional image directories but rejects corrupt supported images', async (context) => {
  const root = await directory(context);
  assert.deepEqual(await optimizeWebImages(join(root, 'absent')), { before: 0, after: 0 });
  await writeFile(join(root, 'broken.png'), 'invalid image');
  await assert.rejects(optimizeWebImages(root));
});
