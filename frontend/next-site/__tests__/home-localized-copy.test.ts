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
  it.each([
    ['id-ID', 'Asisten Ringkasan Nasdaq', 'Rantai utama:', 'penyedia memori', 'Pengingat Friday Night Arena', 'Apa yang sedang menghambat kita?'],
    ['es', 'Asistente del Nasdaq', 'Cadena principal:', 'proveedor de memoria', 'Recordatorio de Friday Night Arena', '¿Qué nos bloquea ahora?'],
    ['ja-JP', 'Nasdaq市場アシスタント', '主な流れ：', '重複レコード', 'Friday Night Arenaのお知らせ', '今のボトルネックを教えて'],
    ['ko-KR', '나스닥 시장 브리핑 도우미', '주요 흐름:', '중복 기록', 'Friday Night Arena 알림', '지금 무엇이 막고 있는지'],
  ] as const)('localizes all four first-screen chat panels for %s', (locale, assistant, report, dev, community, task) => {
    const markup = readFileSync(path.resolve(`public/lightvela-intl-home/index-fragment.${locale}.html`), 'utf8');
    const page = new DOMParser().parseFromString(markup, 'text/html');
    expect(page.querySelector('#panel-wa')?.textContent).toContain(assistant);
    expect(page.querySelector('#panel-wa')?.textContent).toContain(report);
    expect(page.querySelector('#panel-tg')?.textContent).toContain(dev);
    expect(page.querySelector('#panel-dc')?.textContent).toContain(community);
    expect(page.querySelector('#panel-sl')?.textContent).toContain(task);
    expect(page.querySelector('.hero__frame')?.textContent).not.toContain('Nasdaq Brief Assistant');
    expect(page.querySelector('.hero__frame')?.textContent).not.toContain('Main chain:');
    expect(page.querySelector('.hero__frame')?.textContent).not.toContain('@LightVela ask DSH');
  });

  it('uses traditional Chinese throughout the first-screen chat demo', () => {
    const markup = readFileSync(path.resolve('public/lightvela-intl-home/index-fragment.zh-Hant.html'), 'utf8');
    const page = new DOMParser().parseFromString(markup, 'text/html');
    const demo = page.querySelector('.hero__frame')?.textContent ?? '';
    expect(demo).toContain('納斯達克熱門板塊速覽');
    expect(demo).toContain('搜尋或開始新對話');
    expect(demo).not.toMatch(/纳斯达克|软件|网络|搜索|设置|归档|后续|项目/);
  });

  it.each(expected)('keeps the full %s dictionary when adding Blog copy', (locale, home, pricing, docs, headline) => {
    const dictionary = runInNewContext(`const supportedLocales = ['en-US', 'zh-CN', 'zh-SG', 'zh-Hant', 'id-ID', 'es', 'ja-JP', 'ko-KR'];\n${copySetup}\ncoreCopyByLocale[${JSON.stringify(locale)}]`) as Record<string, string>;
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
