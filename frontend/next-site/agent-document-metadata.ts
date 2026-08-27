import {
  localeDefinition,
  parseLocaleCode,
  type I18nDictKey,
} from '@/i18n/locales.config';

import { DEFAULT_PUBLIC_SITE_LOCALE } from './public-locale';

const AGENT_DOCUMENT_TITLE_BY_LOCALE: Record<I18nDictKey, string> = {
  'en-US': 'My Agent',
  'zh-CN': '我的智能体伙伴',
  'zh-Hant': '我的智能體夥伴',
  'id-ID': 'Agent Saya',
  es: 'Mi agente',
  'ja-JP': 'マイエージェント',
  'ko-KR': '내 에이전트',
};

export function getAgentDocumentMetadata(language?: string): {
  title: string;
  htmlLang: string;
} {
  const locale = parseLocaleCode(language) ?? DEFAULT_PUBLIC_SITE_LOCALE;
  const definition = localeDefinition(locale);

  return {
    title: AGENT_DOCUMENT_TITLE_BY_LOCALE[definition.i18nKey],
    htmlLang: definition.htmlLang,
  };
}
