import { mkdtemp, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateMalayHome } from './generate-malay-home.mjs';

const source = path.resolve('public/lightvela-intl-home');

describe('Malay homepage generation', () => {
  it('reproduces the committed page from the current English structure', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'lightvela-malay-home-'));
    try {
      for (const file of ['copy.ms-MY.json', 'index-fragment.en-US.html']) {
        await copyFile(path.join(source, file), path.join(target, file));
      }
      await generateMalayHome(target);
      expect(await readFile(path.join(target, 'index-fragment.ms-MY.html'), 'utf8'))
        .toBe(await readFile(path.join(source, 'index-fragment.ms-MY.html'), 'utf8'));
      const translations = JSON.parse(await readFile(path.join(target, 'copy.ms-MY.json'), 'utf8'));
      delete translations["See what they're saying"];
      await writeFile(path.join(target, 'copy.ms-MY.json'), JSON.stringify(translations));
      await expect(generateMalayHome(target)).rejects.toThrow("Missing Malay homepage translation: See what they're saying");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
