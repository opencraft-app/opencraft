// 类型声明：SDK i18n 词条子路径导出
// en.js / zh.js 是 tea scan 生成的 CJS 文件，没有 .d.ts
declare module "@tencent/tea-sdk-lightclaw/i18n/translation/en" {
  export const translation: Record<string, string>;
}
declare module "@tencent/tea-sdk-lightclaw/i18n/translation/zh" {
  export const translation: Record<string, string>;
}

declare module "@tencent/tea-sdk-lightclaw/styles" {
  const stylesheet: string;
  export default stylesheet;
}
