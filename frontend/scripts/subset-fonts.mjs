import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import subsetFont from 'subset-font';

const frontendRoot = process.cwd();
const fontSourceRoot = join(frontendRoot, 'assets', 'fonts');
const publicFontRoot = join(frontendRoot, 'public', 'fonts');

const textFileExtensions = new Set(['.css', '.json', '.md', '.mdx', '.ts', '.tsx']);
const textInputs = [
  join(frontendRoot, 'src', 'imports', 'Frame2147230025'),
  join(frontendRoot, 'src', 'pages', 'marketing', 'landing-page.tsx'),
  join(frontendRoot, 'src', 'components', 'site', 'landing-cta-footer-links.tsx'),
  join(frontendRoot, 'src', 'i18n', 'generated', 'zh-CN.json'),
  join(frontendRoot, 'src', 'i18n', 'generated', 'en-US.json'),
  // 繁体（zh-Hant）文案：确保字体子集包含繁体专用字形，避免国际站繁体页面缺字。
  join(frontendRoot, 'src', 'i18n', 'generated', 'zh-Hant.json'),
];

const preservedText = [
  // Keep common Latin, numbers, whitespace and punctuation so mixed headings never drop glyphs.
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ' \n\t!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  '，。！？；：“”‘’（）《》【】、·—…「」『』',
].join('');

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

function collectSubsetText() {
  const chunks = [preservedText];
  for (const input of textInputs) {
    for (const file of walkTextFiles(input)) {
      chunks.push(readFileSync(file, 'utf8'));
    }
  }
  return [...new Set(chunks.join(''))].join('');
}

async function writeSubset({ sourceFile, outputFile, text }) {
  const source = readFileSync(join(fontSourceRoot, sourceFile));
  const subset = await subsetFont(source, text, { targetFormat: 'woff2' });
  writeFileSync(join(publicFontRoot, outputFile), subset);
  console.log(`[font-subset] wrote ${outputFile}: ${source.byteLength} -> ${subset.byteLength} bytes`);
}

mkdirSync(publicFontRoot, { recursive: true });

const subsetText = collectSubsetText();
await writeSubset({
  sourceFile: 'HYRuiYiSong-45J.ttf',
  outputFile: 'HYRuiYiSong-45J.subset.woff2',
  text: subsetText,
});
