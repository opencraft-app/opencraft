import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const expected = [
  ['id-ID', 'Beranda', 'Harga', 'Dokumentasi', 'Semakin sering dipakai, semakin memahami kamu, mitra AI yang selalu aktif', 'Perusahaan'],
  ['es', 'Inicio', 'Precios', 'Documentación', 'Cuanto más lo uses, mejor te entenderá, tu compañero de IA siempre en línea', 'Empresa'],
  ['ja-JP', 'ホーム', '料金', 'ドキュメント', '使うほどあなたを理解する、ずっとオンラインのAIパートナー', '会社'],
  ['ko-KR', '홈', '요금', '문서', '쓸수록 나를 더 잘 이해하는, 늘 온라인인 AI 파트너', '회사'],
] as const;

const importer = readFileSync(path.resolve('scripts/import-international-homepage.mjs'), 'utf8');
const copySetup = importer.slice(importer.indexOf('const coreCopyByLocale ='), importer.indexOf('const textFragmentsByLocale ='));

describe('homepage localized copy', () => {
  it.each(expected)('keeps the full %s dictionary when adding Blog copy', (locale, home, pricing, docs, headline) => {
    const dictionary = runInNewContext(`${copySetup}\ncoreCopyByLocale[${JSON.stringify(locale)}]`) as Record<string, string>;
    expect(dictionary.Home).toBe(home);
    expect(dictionary.Pricing).toBe(pricing);
    expect(dictionary.Docs).toBe(docs);
    expect(dictionary.Blog).toBeTruthy();
    expect(dictionary['Your AI companion, always here, always evolving with you']).toBe(headline);
  });

  it.each(expected)('renders %s navigation, headline, and footer in the selected language', (locale, home, pricing, docs, headline, company) => {
    const markup = readFileSync(path.resolve(`public/lightvela-intl-home/index-fragment.${locale}.html`), 'utf8');
    const page = new DOMParser().parseFromString(markup, 'text/html');
    const labels = Array.from(page.querySelectorAll('.nav__links a'), (link) => link.textContent);
    expect(labels).toContain(home);
    expect(labels).toContain(pricing);
    expect(labels).toContain(docs);
    expect(page.querySelector('.hero__line--main')?.textContent).toBe(headline);
    expect(Array.from(page.querySelectorAll('.foot__links h3'), (heading) => heading.textContent)).toContain(company);
    expect(page.querySelector('.foot__copyright br')).not.toBeNull();
    expect(page.querySelector('[for="pl-2"] .play__new-badge')?.textContent).toBe('0 Token');
  });
});
