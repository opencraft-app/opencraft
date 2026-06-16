import type { DocsLanguage } from '@/lib/language';

const zhSummaryByEnglish = new Map<string, string>([
  ['Get CloudAgent capabilities', '获取 CloudAgent 能力'],
  ['List CloudAgent sessions', '列出 CloudAgent 会话'],
  ['Create CloudAgent session', '创建 CloudAgent 会话'],
  ['Load CloudAgent session', '加载 CloudAgent 会话'],
  ['Submit CloudAgent run', '提交 CloudAgent 运行'],
  ['List CloudAgent runs', '列出 CloudAgent 运行'],
  ['Get CloudAgent run', '获取 CloudAgent 运行'],
  ['Replay or stream CloudAgent run events', '回放或流式读取 CloudAgent 运行事件'],
  ['Get CloudAgent run result', '获取 CloudAgent 运行结果'],
  ['Cancel CloudAgent run', '取消 CloudAgent 运行'],
]);

function hasCJK(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function splitBilingualString(value: string): { en: string; zh: string } | undefined {
  if (!hasCJK(value)) return undefined;

  const slashIndex = value.indexOf(' / ');
  if (slashIndex !== -1) {
    return {
      en: value.slice(0, slashIndex).trim(),
      zh: value.slice(slashIndex + 3).trim(),
    };
  }

  const firstCJK = value.search(/[\u3400-\u9fff]/u);
  if (firstCJK === -1) return undefined;

  const prefix = value.slice(0, firstCJK);
  const separatorIndex = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('; '), prefix.lastIndexOf('。'));
  if (separatorIndex === -1) return undefined;

  return {
    en: value.slice(0, separatorIndex + 1).trim(),
    zh: value.slice(separatorIndex + 1).trim(),
  };
}

function localizeString(value: string, language: DocsLanguage) {
  if (language === 'zh') {
    const summary = zhSummaryByEnglish.get(value);
    if (summary) return summary;
  }

  const bilingual = splitBilingualString(value);
  if (!bilingual) return value;

  return bilingual[language];
}

function localizeValue(value: unknown, language: DocsLanguage): unknown {
  if (typeof value === 'string') return localizeString(value, language);

  if (Array.isArray(value)) return value.map((item) => localizeValue(item, language));

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, localizeValue(nestedValue, language)]),
    );
  }

  return value;
}

export function localizeOpenAPI<T>(spec: T, language: DocsLanguage): T {
  return localizeValue(spec, language) as T;
}
