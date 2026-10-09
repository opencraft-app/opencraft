import { create, insert, search } from '@orama/orama';
import { describe, expect, it } from 'vitest';

import { createDocsSearchTokenizer } from '../search-tokenizer';

describe('docs search tokenizer', () => {
  it.each(['en-us', 'ms-my'] as const)('uses the Orama Latin tokenizer for %s', (locale) => {
    expect(createDocsSearchTokenizer(locale)).toBeUndefined();
    const db = create({ schema: { content: 'string' }, components: { tokenizer: createDocsSearchTokenizer(locale) } });
    insert(db, { content: 'Panduan kredit untuk Hermes Agent' });
    expect(search(db, { term: 'kredit' }).count).toBe(1);
  });

  it.each(['zh-cn', 'zh-sg', 'zh-hant'] as const)(
    'uses the Mandarin tokenizer for %s',
    async (locale) => {
      const tokenizer = createDocsSearchTokenizer(locale);
      expect(tokenizer?.language).toBe('mandarin');

      const input = '实名认证需要重新刷脸';
      const tokens = await tokenizer?.tokenize(input);
      expect(tokens).toEqual(expect.arrayContaining(['认证', '需要', '重新']));
      expect(tokens).not.toContain(input);
    },
  );

  it('preserves mixed English product names', async () => {
    const tokenizer = createDocsSearchTokenizer('zh-cn');
    const tokens = await tokenizer?.tokenize('配置 AgentChat 和 LLMGateway');

    expect(tokens).toEqual(expect.arrayContaining(['配置', 'AgentChat', 'LLMGateway']));
  });

  it('finds long Chinese text without storing the entire sentence as one token', () => {
    const tokenizer = createDocsSearchTokenizer('zh-cn');
    const content = '实名认证需要重新刷脸，然后继续完成手机号验证';
    const db = create({
      schema: { content: 'string' },
      components: { tokenizer },
    });

    insert(db, { content });

    expect(tokenizer?.tokenize(content)).not.toContain(content);
    expect(search(db, { term: '实名认证需要重新刷脸' }).count).toBe(1);
  });
});
