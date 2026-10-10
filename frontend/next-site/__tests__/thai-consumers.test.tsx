import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uiTranslations } from 'fumadocs-ui/i18n';
import { ensureThaiPublicCopy } from '@/i18n/thai-copy';
import { getOverviewScenarioTaskPacks } from '@/pages/marketing/scenario-tasks/overview-packs';
import { buildScenarioTaskDraft } from '@/pages/marketing/scenario-tasks/scenario-task-builder';
import { resolveAgentSessionTitle } from '@/pages/marketing/agent-provider-locale';
import { LanguageSwitcher } from '@/components/site/language-switcher';
import { fumadocsTranslations } from '../docs-layout';
import { BUG_FREQUENCY_OPTIONS, PROFILE_ROLE_OPTIONS, localizeSupportLabel } from '../support-page';
import { urlLangForLocale } from '../seo';

vi.mock('../source', () => ({ source: {} }));

beforeAll(ensureThaiPublicCopy);
afterEach(cleanup);

describe('Thai consumer behavior', () => {
  it('asks the model to produce the final response in Thai for every scenario', () => {
    for (const pack of getOverviewScenarioTaskPacks('th-TH')) {
      const draft = buildScenarioTaskDraft({ pack, values: {}, now: new Date('2026-10-09T00:00:00Z') });
      expect(draft.generatedPrompt, pack.id).toMatch(/^Write the final user-facing response in Thai \(th-TH\)\.\n\n/);
      expect(draft.oneShotJobName).toContain('เรียกใช้ครั้งเดียว');
    }
  });

  it('provides every installed Fumadocs UI message and preserves URL interpolation', () => {
    const translations = fumadocsTranslations('th-th');
    for (const key of uiTranslations().keys) {
      expect(translations, key).toHaveProperty(key);
      expect(translations?.[key as keyof typeof translations], key).toBeTruthy();
    }
    expect(translations?.['Page Not Found(404 page)']).toMatch(/[\u0E00-\u0E7F]/);
    expect(translations?.['No results found(search dialog)']).toMatch(/[\u0E00-\u0E7F]/);
    expect(translations?.['Read {url}, I want to ask questions about it.(page actions)']).toContain('{url}');
  });

  it('localizes system chat titles while preserving custom names', () => {
    expect(resolveAgentSessionTitle('新会话', 'th-TH', 'fallback')).toBe('แชทใหม่');
    expect(resolveAgentSessionTitle('ชื่อของฉัน', 'th-TH', 'fallback')).toBe('ชื่อของฉัน');
  });

  it('translates support labels without changing submitted option identifiers', () => {
    for (const option of [...BUG_FREQUENCY_OPTIONS, ...PROFILE_ROLE_OPTIONS]) {
      const label = localizeSupportLabel(option.label, 'th-TH');
      expect(label).not.toBe(option.label);
      expect(label).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(localizeSupportLabel('未知字段', 'th-TH')).toBe('未知字段');
  });

  it('keeps SEO and the China-site menu in the selected locale', () => {
    expect(urlLangForLocale('th-TH')).toBe('th-th');
    render(<LanguageSwitcher activeLocale="th-TH" />);
    fireEvent.click(screen.getByRole('button', { name: 'เปลี่ยนภาษา' }));
    expect(screen.getByRole('option', { name: 'เว็บไซต์จีน' })).toBeInTheDocument();
  });
});
