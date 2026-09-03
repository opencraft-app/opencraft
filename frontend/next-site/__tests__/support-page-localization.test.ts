import { describe, expect, it } from 'vitest';

import {
  BUG_FREQUENCY_OPTIONS,
  PROFILE_FREQUENCY_OPTIONS,
  PROFILE_INDUSTRY_OPTIONS,
  PROFILE_ROLE_OPTIONS,
  PROFILE_SOURCE_OPTIONS,
  localizeSupportLabel,
} from '../support-page';

describe('Spanish support form labels', () => {
  it('localizes every survey and bug-frequency label without Han characters', () => {
    const labels = [
      ...BUG_FREQUENCY_OPTIONS,
      ...PROFILE_FREQUENCY_OPTIONS,
      ...PROFILE_INDUSTRY_OPTIONS,
      ...PROFILE_ROLE_OPTIONS,
      ...PROFILE_SOURCE_OPTIONS,
    ].map((option) => option.label);
    labels.push(
      '调研问卷',
      '可留下微信号或邮箱；',
      '微信号如：lightvela_demo，邮箱如：1234@gmail.com',
    );

    const localized = labels.map((label) => localizeSupportLabel(label, 'es'));
    expect(localized).toContain('Motor de búsqueda');
    expect(localized).toContain('Encuesta');
    expect(localized.join('\n')).not.toMatch(/[\u3400-\u9fff]/u);
  });
});

describe('Japanese support form labels', () => {
  it('localizes every survey and bug-frequency label without Chinese-only text', () => {
    const labels = [
      ...BUG_FREQUENCY_OPTIONS,
      ...PROFILE_FREQUENCY_OPTIONS,
      ...PROFILE_INDUSTRY_OPTIONS,
      ...PROFILE_ROLE_OPTIONS,
      ...PROFILE_SOURCE_OPTIONS,
    ].map((option) => option.label);
    labels.push(
      '调研问卷',
      '可留下微信号或邮箱；',
      '微信号如：lightvela_demo，邮箱如：1234@gmail.com',
    );

    const localized = labels.map((label) => localizeSupportLabel(label, 'ja-JP'));
    expect(localized).toContain('検索エンジン');
    expect(localized).toContain('アンケート');
    for (const [index, label] of localized.entries()) {
      if (labels[index] === '学生' || labels[index] === '教育') continue;
      expect(label, `missing Japanese support label: ${labels[index]}`).not.toBe(labels[index]);
    }
  });
});
