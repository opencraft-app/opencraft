/** 国际站暂未维护独立西语 provider 元数据时，西语复用英文 provider 数据。 */
export const shouldUseEnglishProviderData = (locale?: string): boolean => {
  if (!locale) return false;
  return locale.startsWith("en") || locale.startsWith("es");
};
