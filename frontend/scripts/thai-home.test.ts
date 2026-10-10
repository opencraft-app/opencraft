import { mkdtemp, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateThaiHome } from './generate-thai-home.mjs';

const source = path.resolve('public/lightvela-intl-home');

describe('Thai homepage generation', () => {
  it('reproduces the committed page from the current English structure', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'lightvela-thai-home-'));
    try {
      for (const file of ['copy.th-TH.json', 'index-fragment.en-US.html']) {
        await copyFile(path.join(source, file), path.join(target, file));
      }
      await generateThaiHome(target);
      expect(await readFile(path.join(target, 'index-fragment.th-TH.html'), 'utf8'))
        .toBe(await readFile(path.join(source, 'index-fragment.th-TH.html'), 'utf8'));
      const translations = JSON.parse(await readFile(path.join(target, 'copy.th-TH.json'), 'utf8'));
      delete translations["See what they're saying"];
      await writeFile(path.join(target, 'copy.th-TH.json'), JSON.stringify(translations));
      await expect(generateThaiHome(target)).rejects.toThrow("Missing Thai homepage translation: See what they're saying");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
