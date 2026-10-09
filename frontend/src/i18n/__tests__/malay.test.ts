import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import malay from '../generated/ms-MY.json';
import base from '../generated/zh-CN.json';
import { localizeMalay } from '../malay-copy';
import { localeDefinition, parseLocaleCode } from '../locales.config';
import { DOCS_ROUTE_SLUGS } from '../../../next-site/docs-route-manifest';
import { getTermsOfServiceChrome } from '@/pages/marketing/terms-of-service-page';
import { getPrivacyPolicyCopy } from '@/pages/marketing/privacy-policy-page';
import { getCookiePolicyCopy } from '@/pages/marketing/cookie-policy-page';
import { translateNoticeText } from '@/pages/marketing/open-source-licenses-page';
import { CURATED_SKILL_CATEGORIES } from '@/pages/marketing/skills-demo/curated-skill-categories';
import { getOverviewScenarioTaskPacks } from '@/pages/marketing/scenario-tasks/overview-packs';

const dictionary: Record<string, string> = malay;

describe('Malay international site', () => {
  it('publishes an explicit Malay locale with independent docs and no fallback', () => {
    expect(parseLocaleCode('ms-MY')).toBe('ms-MY');
    expect(localeDefinition('ms-MY')).toMatchObject({
      displayName: 'Bahasa Melayu', urlLang: 'ms-my', docsSourcePrefix: 'ms',
      docsFallbackPrefixes: [], switcherVisible: true, translationRequired: true,
    });
  });

  it('translates every UI entry and preserves interpolation and markup', () => {
    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(base).sort());
    for (const [key, source] of Object.entries(base)) {
      const translated = dictionary[key];
      expect(translated?.trim(), key).toBeTruthy();
      expect(translated?.match(/\{\{[^}]+\}\}/g)?.sort() ?? [], key)
        .toEqual(source.match(/\{\{[^}]+\}\}/g)?.sort() ?? []);
      expect(translated, key).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('offers all international English docs as independent Malay routes', () => {
    expect(DOCS_ROUTE_SLUGS['ms-my']).toEqual(DOCS_ROUTE_SLUGS['en-us']);
    const overview = readFileSync(path.join(process.cwd(), '.fumadocs-content/docs/ms-my/overview.mdx'), 'utf8');
    expect(overview).toContain('source_path: "src/content/docs/ms/01-overview.md"');
    expect(overview).toContain('Ringkasan');
    expect(overview).not.toMatch(/ZQX|⟦\d+⟧/);
  });

  it('localizes independent public and legal structures', () => {
    expect(getTermsOfServiceChrome('ms-MY').title).toBe('Syarat Perkhidmatan');
    expect(getPrivacyPolicyCopy('ms-MY').title).toBe('Dasar Privasi');
    expect(getCookiePolicyCopy('ms-MY').title).toBe('Dasar Kuki');
    expect(localizeMalay({ brand: 'LightVela', title: 'Home' }))
    .toEqual({ brand: 'LightVela', title: 'Laman Utama' });
  });

  it('preserves identifiers and treats inherited object properties as untranslated text', () => {
    expect(localizeMalay({ id: 'Home', href: '/docs/overview', title: 'Home', nested: { fieldKey: 'Home' } }))
      .toEqual({ id: 'Home', href: '/docs/overview', title: 'Laman Utama', nested: { fieldKey: 'Home' } });
    for (const text of ['constructor', 'toString', '__proto__']) expect(localizeMalay(text)).toBe(text);
  });

  it('translates shared skill categories and preserves open source license names', () => {
    for (const category of CURATED_SKILL_CATEGORIES) {
      expect(localizeMalay(category.label.en), category.id).not.toBe(category.label.en);
    }
    expect(translateNoticeText('Terms of the MIT License:', 'ms-MY')).toBe('Syarat lesen MIT License:');
  });

  it('translates every English prompt fragment while preserving field bindings', () => {
    const english = getOverviewScenarioTaskPacks('en-US');
    const malay = getOverviewScenarioTaskPacks('ms-MY');
    for (const [index, pack] of english.entries()) {
      const localized = malay[index];
      if (!localized) throw new Error(`Missing Malay pack: ${pack.id}`);
      expect(localized.id).toBe(pack.id);
      for (const [partIndex, part] of (pack.quickPromptTemplate ?? []).entries()) {
        const translated = localized.quickPromptTemplate?.[partIndex];
        expect(translated?.type).toBe(part.type);
        if (part.type === 'field') {
          expect(translated).toMatchObject({ fieldKey: part.fieldKey });
        } else if (/[A-Za-z]/.test(part.text)) {
          expect(translated, pack.id).not.toMatchObject({ text: part.text });
        }
      }
    }
  });

  it('keeps product links usable and translates homepage runtime copy', () => {
    const markup = readFileSync(path.join(process.cwd(), 'public/lightvela-intl-home/index-fragment.ms-MY.html'), 'utf8');
    const document = new DOMParser().parseFromString(markup, 'text/html');
    expect(document.querySelector('a[href="/agents"]')).not.toBeNull();
    expect(document.querySelector('a[href^="/ms-my/agents"]')).toBeNull();
    expect(document.querySelector('a[href^="/ms-my/docs"]')).not.toBeNull();
    expect(markup).not.toMatch(/ZQXSEP|⟦\d+⟧/);
    const rotator = document.querySelector('[data-rotator-words]');
    expect(rotator).not.toBeNull();
    expect(JSON.parse(rotator!.getAttribute('data-rotator-words')!)).not.toContain('work assistant');
    expect(document.querySelector('[data-full-html]')?.getAttribute('data-full-html')).not.toBe('');
  });
});
