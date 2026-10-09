import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uiTranslations } from 'fumadocs-ui/i18n';
import { ensureMalayPublicCopy } from '@/i18n/malay-copy';
import { getOverviewScenarioTaskPacks } from '@/pages/marketing/scenario-tasks/overview-packs';
import { buildScenarioTaskDraft } from '@/pages/marketing/scenario-tasks/scenario-task-builder';
import { resolveAgentSessionTitle } from '@/pages/marketing/agent-provider-locale';
import { LanguageSwitcher } from '@/components/site/language-switcher';
import { fumadocsTranslations } from '../docs-layout';
import { BUG_FREQUENCY_OPTIONS, PROFILE_ROLE_OPTIONS, localizeSupportLabel } from '../support-page';
import { urlLangForLocale } from '../seo';

vi.mock('../source', () => ({ source: {} }));

beforeAll(ensureMalayPublicCopy);
afterEach(cleanup);

describe('Malay consumer behavior', () => {
  it('asks the model to produce the final response in Malay for every scenario', () => {
    for (const pack of getOverviewScenarioTaskPacks('ms-MY')) {
      const draft = buildScenarioTaskDraft({ pack, values: {}, now: new Date('2026-10-09T00:00:00Z') });
      expect(draft.generatedPrompt, pack.id).toMatch(/^Write the final user-facing response in Bahasa Melayu \(ms-MY\)\.\n\n/);
      expect(draft.oneShotJobName).toContain('pelaksanaan sekali');
    }
  });

  it('provides every installed Fumadocs UI message and preserves URL interpolation', () => {
    const translations = fumadocsTranslations('ms-my');
    for (const key of uiTranslations().keys) {
      expect(translations, key).toHaveProperty(key);
      expect(translations?.[key as keyof typeof translations], key).toBeTruthy();
    }
    expect(translations).toMatchObject({
      'Page Not Found(404 page)': 'Halaman tidak dijumpai',
      'No results found(search dialog)': 'Tiada hasil dijumpai',
      'Read {url}, I want to ask questions about it.(page actions)': 'Baca {url}, saya ingin bertanya tentangnya.',
    });
  });

  it('localizes system chat titles while preserving custom names', () => {
    expect(resolveAgentSessionTitle('新会话', 'ms-MY', 'fallback')).toBe('Sembang baharu');
    expect(resolveAgentSessionTitle('Nama saya sendiri', 'ms-MY', 'fallback')).toBe('Nama saya sendiri');
  });

  it('translates support labels without changing submitted option identifiers', () => {
    for (const option of [...BUG_FREQUENCY_OPTIONS, ...PROFILE_ROLE_OPTIONS]) {
      const label = localizeSupportLabel(option.label, 'ms-MY');
      expect(label).not.toBe(option.label);
      expect(label).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(localizeSupportLabel('未知字段', 'ms-MY')).toBe('未知字段');
  });

  it('keeps SEO and the China-site menu in the selected locale', () => {
    expect(urlLangForLocale('ms-MY')).toBe('ms-my');
    render(<LanguageSwitcher activeLocale="ms-MY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tukar bahasa' }));
    expect(screen.getByRole('option', { name: 'Laman China' })).toBeInTheDocument();
  });
});
