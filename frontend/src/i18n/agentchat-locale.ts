import type { SupportedLocale } from './index';

let preparation: Promise<void> = Promise.resolve();

/** Apply language changes in request order so a delayed Malay chunk cannot undo a later switch. */
export function prepareAgentChatLocale(locale: SupportedLocale): Promise<void> {
  preparation = preparation.catch(() => undefined).then(() => applyAgentChatLocale(locale));
  return preparation;
}

/** The SDK ships a separate i18next major version; initialize that exact shared runtime. */
async function applyAgentChatLocale(locale: SupportedLocale): Promise<void> {
  const sdk = (await import('agentchat-i18next')).default;
  const language = locale === 'ms-MY' ? locale
    : locale === 'zh-CN' || locale === 'zh-SG' || locale === 'zh-Hant' ? 'zh-CN' : 'en-US';
  const malay = language === 'ms-MY' ? (await import('./generated/agentchat-ms-MY.json')).default : null;
  if (!sdk.isInitialized) {
    await sdk.init({
      lng: language,
      fallbackLng: 'en-US',
      resources: malay ? { 'ms-MY': { translation: malay } } : {},
      interpolation: { escapeValue: false },
    });
  } else {
    if (malay) sdk.addResourceBundle('ms-MY', 'translation', malay, true, false);
    await sdk.changeLanguage(language);
  }
}
