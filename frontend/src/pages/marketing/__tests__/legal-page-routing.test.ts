import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  cookiePolicyHomePath,
  getCookiePolicyChrome,
  getCookiePolicyCopy,
  CookiePolicyParagraph,
  renderCookiePolicyInlineLinks,
} from '../cookie-policy-page';
import {
  getOpenSourceLicensesChrome,
  publicLocaleHomePath as openSourceHomePath,
  translateNoticeText,
} from '../open-source-licenses-page';
import {
  getPrivacyPolicyChrome,
  getPrivacyPolicyCopy,
  getPrivacyPolicyTableHeaders,
  PrivacyPolicyParagraph,
  publicLocaleHomePath as privacyHomePath,
} from '../privacy-policy-page';
import {
  getTermsOfServiceBlocks,
  getTermsOfServiceChrome,
  localizedLegalPath,
  localizedLightVelaUrl,
} from '../terms-of-service-page';

const spanishEnglishPrevailsDisclaimer =
  'En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.';
const japaneseEnglishPrevailsDisclaimer =
  '英語版と本日本語訳の間に相違または不一致がある場合、適用法令に別段の定めがない限り、英語版が優先されます。';

describe('Japanese legal page navigation', () => {
  it('keeps every legal page and internal legal link under /ja-jp', () => {
    expect(cookiePolicyHomePath('ja-JP')).toBe('/ja-jp/');
    expect(openSourceHomePath('ja-JP')).toBe('/ja-jp/');
    expect(privacyHomePath('ja-JP')).toBe('/ja-jp/');
    expect(localizedLegalPath('/', 'ja-JP', true)).toBe('/ja-jp/');
    expect(localizedLightVelaUrl('https://lightvela.ai/zh-sg/privacy-policy/', 'ja-JP', true)).toEqual({
      href: '/ja-jp/privacy-policy/',
      label: 'https://lightvela.ai/ja-jp/privacy-policy/',
    });
  });

  it('keeps Japanese legal structures aligned with English and includes the English-prevails disclaimer', () => {
    const japanesePrivacy = getPrivacyPolicyCopy('ja-JP');
    const englishPrivacy = getPrivacyPolicyCopy('en-US');
    expect(japanesePrivacy).toMatchObject({
      title: 'プライバシーポリシー',
      languageTitle: '10. 言語',
      languageParagraph: japaneseEnglishPrevailsDisclaimer,
    });
    expect(japanesePrivacy.intro).toHaveLength(englishPrivacy.intro.length);
    expect(japanesePrivacy.processRows.map((group) => group.data.length)).toEqual(
      englishPrivacy.processRows.map((group) => group.data.length),
    );
    expect(japanesePrivacy.shareBullets).toHaveLength(englishPrivacy.shareBullets.length);
    expect(japanesePrivacy.retentionRows).toHaveLength(englishPrivacy.retentionRows.length);
    expect(japanesePrivacy.rightsBullets).toHaveLength(englishPrivacy.rightsBullets.length);
    expect(getPrivacyPolicyTableHeaders('ja-JP')).toEqual({
      personal: '個人情報',
      use: '利用目的',
      legalBasis: '法的根拠（該当する場合）',
      retentionPolicy: '保存方針',
    });

    const japaneseCookies = getCookiePolicyCopy('ja-JP');
    const englishCookies = getCookiePolicyCopy('en-US');
    expect(japaneseCookies.sections.at(-1)).toEqual({
      title: '7. 言語',
      paragraphs: [japaneseEnglishPrevailsDisclaimer],
    });
    expect(japaneseCookies.sections).toHaveLength(englishCookies.sections.length + 1);
    expect(japaneseCookies.sections.flatMap((section) => section.tableRows ?? [])).toHaveLength(
      englishCookies.sections.flatMap((section) => section.tableRows ?? []).length,
    );

    const japaneseTerms = getTermsOfServiceBlocks('ja-JP', []);
    expect(japaneseTerms).toHaveLength(455);
    expect(japaneseTerms).toEqual(expect.arrayContaining([
      { kind: 'h2', text: '言語' },
      { kind: 'paragraph', text: japaneseEnglishPrevailsDisclaimer },
    ]));
  });

  it('localizes Japanese page chrome and Open Source headings while preserving license terms', () => {
    expect(getPrivacyPolicyChrome('ja-JP')).toMatchObject({
      backHome: 'ホームに戻る',
      title: 'プライバシーポリシー',
      updated: '最終更新: 2026年8月',
    });
    expect(getCookiePolicyChrome('ja-JP')).toMatchObject({
      backHome: 'ホームに戻る',
      title: 'Cookieポリシー',
    });
    expect(getTermsOfServiceChrome('ja-JP')).toMatchObject({
      backHome: 'ホームに戻る',
      title: '利用規約',
    });
    expect(getOpenSourceLicensesChrome('ja-JP')).toMatchObject({
      backHome: 'ホームに戻る',
      title: 'オープンソースに関する通知',
      updated: '最終更新: 2026年8月',
    });
    expect(translateNoticeText('Terms of the Apache License 2.0:', 'ja-JP')).toBe(
      'Apache License 2.0の条項:',
    );
    expect(translateNoticeText('Permission is hereby granted, free of charge, to any person obtaining a copy', 'ja-JP')).toBe(
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
    );

    const cookieLinks = renderToStaticMarkup(React.createElement(CookiePolicyParagraph, {
      text: 'お問い合わせはこちら。Chrome（ウェブ）のCookie設定とChromeブラウザのアドオン、すべてのCookieについてをご確認ください。',
    }));
    expect(cookieLinks).toContain('mailto:lightvela@tencent.com');
    expect(cookieLinks).toContain('hl=ja');
    expect(cookieLinks).toContain('https://tools.google.com/dlpage/gaoptout');
    expect(cookieLinks).toContain('https://allaboutcookies.org/');
  });
});

describe('Spanish legal page navigation', () => {
  it('keeps every legal page home link under /es', () => {
    expect(cookiePolicyHomePath('es')).toBe('/es/');
    expect(openSourceHomePath('es')).toBe('/es/');
    expect(privacyHomePath('es')).toBe('/es/');
    expect(localizedLegalPath('/', 'es', true)).toBe('/es/');
  });

  it('keeps internal LightVela legal links under /es', () => {
    expect(localizedLightVelaUrl('https://lightvela.ai/zh-sg/privacy-policy/', 'es', true)).toEqual({
      href: '/es/privacy-policy/',
      label: 'https://lightvela.ai/es/privacy-policy/',
    });
  });

  it('localizes Open Source structure while keeping license terms in English', () => {
    expect(translateNoticeText('Open Source Software Licensed under the MIT License:', 'es')).toBe(
      'Software de código abierto con licencia MIT License:',
    );
    expect(translateNoticeText('Terms of the Apache License 2.0:', 'es')).toBe(
      'Términos de la Apache License 2.0:',
    );
    expect(
      translateNoticeText(
        'You may obtain the source code and detailed information about this component at https://example.com.',
        'es',
      ),
    ).toBe('Puede obtener el código fuente y la información detallada de este componente en https://example.com.');
    expect(translateNoticeText('Permission is hereby granted, free of charge, to any person obtaining a copy', 'es')).toBe(
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
    );
  });

  it('provides complete Spanish legal body selectors with an English-prevails disclaimer', () => {
    const spanishPrivacy = getPrivacyPolicyCopy('es');
    const englishPrivacy = getPrivacyPolicyCopy('en-US');
    expect(spanishPrivacy).toMatchObject({
      title: 'Política de privacidad',
      languageTitle: '10. Idioma',
      languageParagraph: spanishEnglishPrevailsDisclaimer,
    });
    expect(spanishPrivacy.intro[0]).toContain('Política de privacidad');
    expect(spanishPrivacy.intro).toHaveLength(englishPrivacy.intro.length);
    expect(spanishPrivacy.processRows.map((group) => group.data.length)).toEqual(
      englishPrivacy.processRows.map((group) => group.data.length),
    );
    expect(spanishPrivacy.shareBullets).toHaveLength(englishPrivacy.shareBullets.length);
    expect(spanishPrivacy.retentionRows).toHaveLength(englishPrivacy.retentionRows.length);
    expect(spanishPrivacy.rightsBullets).toHaveLength(englishPrivacy.rightsBullets.length);
    expect(getPrivacyPolicyTableHeaders('es')).toEqual({
      personal: 'Información personal',
      use: 'Uso',
      legalBasis: 'Base jurídica (cuando corresponda)',
      retentionPolicy: 'Política de conservación',
    });

    const spanishCookies = getCookiePolicyCopy('es');
    const englishCookies = getCookiePolicyCopy('en-US');
    expect(spanishCookies.sections.at(-1)).toEqual({
      title: '7. IDIOMA',
      paragraphs: [spanishEnglishPrevailsDisclaimer],
    });
    expect(spanishCookies.sections).toHaveLength(englishCookies.sections.length + 1);
    expect(spanishCookies.sections.flatMap((section) => section.tableRows ?? [])).toHaveLength(
      englishCookies.sections.flatMap((section) => section.tableRows ?? []).length,
    );
    expect(renderCookiePolicyInlineLinks(spanishEnglishPrevailsDisclaimer)).toEqual([
      spanishEnglishPrevailsDisclaimer,
    ]);

    const spanishTerms = getTermsOfServiceBlocks('es', []);
    const indonesianTerms = getTermsOfServiceBlocks('id-ID', []);
    expect(spanishTerms).toHaveLength(indonesianTerms.length + 2);
    expect(spanishTerms).toEqual(
      expect.arrayContaining([
        { kind: 'h2', text: 'Idioma' },
        { kind: 'paragraph', text: spanishEnglishPrevailsDisclaimer },
      ]),
    );
  });

  it('localizes legal page chrome without claiming translated bodies are English-only', () => {
    expect(getPrivacyPolicyChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Política de privacidad',
      updated: 'Última actualización: agosto de 2026',
    });
    expect(getCookiePolicyChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Política de cookies',
    });
    expect(getTermsOfServiceChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Términos del servicio',
      note: expect.not.stringContaining('se ofrece en inglés'),
    });
    expect(getOpenSourceLicensesChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Aviso de código abierto',
      updated: 'Última actualización: agosto de 2026',
    });
  });

  it('renders multiline legal copy without nesting block elements inside paragraphs', () => {
    const privacyMarkup = renderToStaticMarkup(
      React.createElement(PrivacyPolicyParagraph, { text: 'Primer párrafo.\n\nSegundo párrafo.' }),
    );
    const cookieMarkup = renderToStaticMarkup(
      React.createElement(CookiePolicyParagraph, { text: 'Primer párrafo.\n\nSegundo párrafo.' }),
    );

    expect(privacyMarkup).not.toMatch(/<p[^>]*>\s*<div/);
    expect(cookieMarkup).not.toMatch(/<p[^>]*>\s*<div/);
    expect(privacyMarkup.match(/<p/g)).toHaveLength(2);
    expect(cookieMarkup.match(/<p/g)).toHaveLength(2);
  });
});
