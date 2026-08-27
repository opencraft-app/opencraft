import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import subsetFont from 'subset-font';

const textFileExtensions = new Set(['.css', '.json', '.md', '.mdx', '.ts', '.tsx']);
export const SPANISH_SOURCE_FONT_SUBSET_CHARS = 'áéíóúüÁÉÍÓÚÜ';
export const SPANISH_SOURCE_FONT_FALLBACK_CHARS = 'ñÑ¿¡';
export const SPANISH_REQUIRED_CHARS = SPANISH_SOURCE_FONT_SUBSET_CHARS + SPANISH_SOURCE_FONT_FALLBACK_CHARS;

export const PRESERVED_TEXT = [
  // Keep common Latin, numbers, whitespace and punctuation so mixed headings never drop glyphs.
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ' \n\t!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  '，。！？；：“”‘’（）《》【】、·—…「」『』',
].join('');

function readLocaleDefinitions(frontendRoot) {
  return JSON.parse(readFileSync(join(frontendRoot, 'src', 'i18n', 'locales.json'), 'utf8'));
}

export function publishedDictionaryKeys(localeDefinitions) {
  return [
    ...new Set(
      localeDefinitions
        .filter((definition) => definition.switcherVisible)
        .map((definition) => definition.i18nKey),
    ),
  ];
}

export function getSubsetTextInputs(frontendRoot, localeDefinitions = readLocaleDefinitions(frontendRoot)) {
  const codeInputs = [
    join(frontendRoot, 'src', 'imports', 'Frame2147230025'),
    join(frontendRoot, 'src', 'pages', 'marketing', 'landing-page.tsx'),
  ];
  const dictionaryInputs = publishedDictionaryKeys(localeDefinitions).map((locale) =>
    join(frontendRoot, 'src', 'i18n', 'generated', `${locale}.json`),
  );
  return [...codeInputs, ...dictionaryInputs];
}

function walkTextFiles(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) {
    return textFileExtensions.has(extname(path)) ? [path] : [];
  }
  if (!stat.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'out' || entry.name.startsWith('dist')) {
      continue;
    }
    files.push(...walkTextFiles(join(path, entry.name)));
  }
  return files;
}

export function collectSubsetText({
  inputs,
  walkFiles = walkTextFiles,
  readText = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const chunks = [PRESERVED_TEXT, SPANISH_REQUIRED_CHARS];
  for (const input of inputs ?? []) {
    for (const file of walkFiles(input)) {
      chunks.push(readText(file));
    }
  }
  return [...new Set(chunks.join(''))].join('');
}

function findTable(font, expectedTag) {
  const tableCount = font.readUInt16BE(4);
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    if (font.toString('ascii', recordOffset, recordOffset + 4) === expectedTag) {
      return { offset: font.readUInt32BE(recordOffset + 8), length: font.readUInt32BE(recordOffset + 12) };
    }
  }
  return undefined;
}

function format4HasGlyph(font, offset, codePoint) {
  if (codePoint > 0xffff) return false;
  const length = font.readUInt16BE(offset + 2);
  const segmentCount = font.readUInt16BE(offset + 6) / 2;
  const endCodesOffset = offset + 14;
  const startCodesOffset = endCodesOffset + segmentCount * 2 + 2;
  const deltasOffset = startCodesOffset + segmentCount * 2;
  const rangeOffsetsOffset = deltasOffset + segmentCount * 2;

  for (let index = 0; index < segmentCount; index += 1) {
    const end = font.readUInt16BE(endCodesOffset + index * 2);
    const start = font.readUInt16BE(startCodesOffset + index * 2);
    if (codePoint < start || codePoint > end) continue;

    const delta = font.readInt16BE(deltasOffset + index * 2);
    const rangeOffsetPosition = rangeOffsetsOffset + index * 2;
    const rangeOffset = font.readUInt16BE(rangeOffsetPosition);
    if (rangeOffset === 0) return ((codePoint + delta) & 0xffff) !== 0;

    const glyphOffset = rangeOffsetPosition + rangeOffset + (codePoint - start) * 2;
    if (glyphOffset + 2 > offset + length) return false;
    const glyph = font.readUInt16BE(glyphOffset);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

function format12HasGlyph(font, offset, codePoint) {
  const groupCount = font.readUInt32BE(offset + 12);
  for (let index = 0; index < groupCount; index += 1) {
    const groupOffset = offset + 16 + index * 12;
    const start = font.readUInt32BE(groupOffset);
    const end = font.readUInt32BE(groupOffset + 4);
    if (codePoint < start || codePoint > end) continue;
    return font.readUInt32BE(groupOffset + 8) + codePoint - start !== 0;
  }
  return false;
}

export function classifySourceGlyphs(source, requiredChars = SPANISH_REQUIRED_CHARS) {
  const font = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const cmap = findTable(font, 'cmap');
  if (!cmap) throw new Error('[font-subset] source font has no cmap table');

  const subtableCount = font.readUInt16BE(cmap.offset + 2);
  const subtables = [];
  for (let index = 0; index < subtableCount; index += 1) {
    const recordOffset = cmap.offset + 4 + index * 8;
    const offset = cmap.offset + font.readUInt32BE(recordOffset + 4);
    const format = font.readUInt16BE(offset);
    if (format === 4 || format === 12) subtables.push({ format, offset });
  }

  let supported = '';
  let missing = '';
  for (const char of requiredChars) {
    const codePoint = char.codePointAt(0);
    const hasGlyph = subtables.some((subtable) =>
      subtable.format === 4
        ? format4HasGlyph(font, subtable.offset, codePoint)
        : format12HasGlyph(font, subtable.offset, codePoint),
    );
    if (hasGlyph) supported += char;
    else missing += char;
  }
  return { supported, missing };
}

async function writeSubset({ source, publicFontRoot, outputFile, text }) {
  const subset = await subsetFont(source, text, { targetFormat: 'woff2' });
  writeFileSync(join(publicFontRoot, outputFile), subset);
  console.log(`[font-subset] wrote ${outputFile}: ${source.byteLength} -> ${subset.byteLength} bytes`);
}

export async function runSubsetFonts(frontendRoot = process.cwd()) {
  const fontSourceRoot = join(frontendRoot, 'assets', 'fonts');
  const publicFontRoot = join(frontendRoot, 'public', 'fonts');
  mkdirSync(publicFontRoot, { recursive: true });

  const subsetText = collectSubsetText({ inputs: getSubsetTextInputs(frontendRoot) });
  const source = readFileSync(join(fontSourceRoot, 'HYRuiYiSong-45J.ttf'));
  const sourceGlyphs = classifySourceGlyphs(source);
  await writeSubset({
    source,
    publicFontRoot,
    outputFile: 'HYRuiYiSong-45J.subset.woff2',
    text: subsetText,
  });
  console.log(
    `[font-subset] Spanish source-font supported: ${sourceGlyphs.supported || '(none)'}; ` +
      `source-font missing (system fallback): ${sourceGlyphs.missing || '(none)'}`,
  );
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectExecution) await runSubsetFonts();
