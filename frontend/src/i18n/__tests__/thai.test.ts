import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import thai from '../generated/th-TH.json';
import base from '../generated/zh-CN.json';
import { ensureThaiPublicCopy, localizeThai } from '../thai-copy';
import { localeDefinition, parseLocaleCode } from '../locales.config';
import { DOCS_ROUTE_SLUGS } from '../../../next-site/docs-route-manifest';
import { getTermsOfServiceChrome } from '@/pages/marketing/terms-of-service-page';
import { getPrivacyPolicyCopy } from '@/pages/marketing/privacy-policy-page';
import { getCookiePolicyCopy } from '@/pages/marketing/cookie-policy-page';
import { translateNoticeText } from '@/pages/marketing/open-source-licenses-page';
import { CURATED_SKILL_CATEGORIES } from '@/pages/marketing/skills-demo/curated-skill-categories';
import { getOverviewScenarioTaskPacks } from '@/pages/marketing/scenario-tasks/overview-packs';
import { buildScenarioTaskDraft } from '@/pages/marketing/scenario-tasks/scenario-task-builder';

const dictionary: Record<string, string> = thai;

describe('Thai international site', () => {
  beforeAll(ensureThaiPublicCopy);
  it('publishes a Thai locale with independent docs and font fallback', () => {
    expect(parseLocaleCode('th-TH')).toBe('th-TH');
    expect(localeDefinition('th-TH')).toMatchObject({ displayName: 'ไทย', urlLang: 'th-th', docsSourcePrefix: 'th', docsFallbackPrefixes: [], switcherVisible: true, translationRequired: true, requiresFontFallback: true, fontSubsetEligible: false });
  });
  it('translates every UI entry while preserving interpolation and markup', () => {
    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(base).sort());
    for (const [key, source] of Object.entries(base)) {
      const translated = dictionary[key];
      expect(translated?.trim(), key).toBeTruthy();
      expect(translated?.match(/\{\{[^}]+\}\}/g)?.sort() ?? [], key).toEqual(source.match(/\{\{[^}]+\}\}/g)?.sort() ?? []);
      expect(translated, key).not.toMatch(/[\u4e00-\u9fff]|__THAI_|⟦\d+⟧/);
    }
  });
  it('offers all English docs as independent Thai routes and preserves executable content', () => {
    expect(DOCS_ROUTE_SLUGS['th-th']).toEqual(DOCS_ROUTE_SLUGS['en-us']);
    const root = path.join(process.cwd(), 'src/content/docs');
    const files = readdirSync(path.join(root, 'en'), { recursive: true }).filter((name): name is string => typeof name === 'string' && name.endsWith('.md'));
    const fenced = (text: string) => text.match(/```[^\n]*\n[\s\S]*?\n```[^\n]*|~~~[^\n]*\n[\s\S]*?\n~~~[^\n]*/g) ?? [];
    const inline = (text: string) => text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').match(/`[^`\n]+`/g) ?? [];
    const links = (text: string) => [...text.matchAll(/\]\(([^)]*)\)/g)].map((match) => match[1]);
    for (const file of files) {
      const en = readFileSync(path.join(root, 'en', file), 'utf8');
      const th = readFileSync(path.join(root, 'th', file), 'utf8');
      expect(th, file).toMatch(/[\u0E00-\u0E7F]/);
      expect(th, file).not.toMatch(/__THAI_|⟦\d+⟧/);
      expect(fenced(th), file).toEqual(fenced(en));
      expect(inline(th), file).toEqual(inline(en));
      expect(links(th), file).toEqual(links(en));
    }
  });
  it('localizes public and legal copy', () => {
    expect(getTermsOfServiceChrome('th-TH').title).toBe('ข้อกำหนดการให้บริการ');
    expect(getPrivacyPolicyCopy('th-TH').title).toBe('นโยบายความเป็นส่วนตัว');
    expect(getCookiePolicyCopy('th-TH').title).toBe('นโยบายคุกกี้');
    expect(translateNoticeText('Terms of the MIT License:', 'th-TH')).toContain('MIT License');
  });
  it('preserves identities, links, and inherited property names', () => {
    expect(localizeThai({ id: 'Home', href: '/docs/overview', title: 'Home', nested: { fieldKey: 'Home' } })).toEqual({ id: 'Home', href: '/docs/overview', title: 'หน้าหลัก', nested: { fieldKey: 'Home' } });
    for (const text of ['constructor', 'toString', '__proto__']) expect(localizeThai(text)).toBe(text);
  });
  it('translates shared skill categories only after Thai copy is ready', () => {
    for (const category of CURATED_SKILL_CATEGORIES) expect(localizeThai(category.label.en), category.id).toMatch(/[\u0E00-\u0E7F]/);
  });
  it('preserves scenario fields and requests a Thai final response', () => {
    const english = getOverviewScenarioTaskPacks('en-US');
    const localized = getOverviewScenarioTaskPacks('th-TH');
    for (const [index, pack] of english.entries()) {
      const th = localized[index];
      if (!th) throw new Error(`Missing Thai scenario: ${pack.id}`);
      expect(th.id).toBe(pack.id);
      expect(th.quickPromptLocale).toBe('th-TH');
      expect(th.fields.map((field) => field.key)).toEqual(pack.fields.map((field) => field.key));
      expect(th.fields.map((field) => field.options?.map((option) => option.value))).toEqual(pack.fields.map((field) => field.options?.map((option) => option.value)));
      for (const [partIndex, part] of (pack.quickPromptTemplate ?? []).entries()) {
        const translated = th.quickPromptTemplate?.[partIndex];
        expect(translated?.type).toBe(part.type);
        if (part.type === 'field') expect(translated).toMatchObject({ fieldKey: part.fieldKey });
        else if (/[A-Za-z]/.test(part.text)) expect(translated).not.toMatchObject({ text: part.text });
      }
      expect(buildScenarioTaskDraft({ pack: th, values: {} }).generatedPrompt).toContain('Thai (th-TH)');
    }
  });
});
