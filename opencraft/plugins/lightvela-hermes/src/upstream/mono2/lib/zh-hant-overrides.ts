// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 简→繁（zh-Hant）术语校正表（OpenCC `cn→hk` 之后的整词替换）
 * ──────────────────────────────────────────────────────────────
 * 背景：
 *   OpenCC 的 `cn→hk` 会按香港《常用字字形表》把简体字统一到"正字"形态，
 *   其中一些字虽然字形规范，但与港澳日常大众书写习惯有落差 —— 微信、
 *   报刊、社交媒体几乎不会写这些字。为了让繁体站读起来更贴近大众阅读
 *   习惯，我们在 OpenCC 结果之后再套一层"回退表"，把过度学院化的
 *   写法退回大众通用写法。
 *
 * 例：
 *   - 群組 vs 羣組：港标本字是「羣」，但微信/日常几乎都写「群」→ 回退为「群」
 *
 * 该表被以下三处共享：
 *   1. `src/lib/zh-hant.ts`（法律页运行时转换）
 *   2. `src/pages/marketing/zh-hant-scope.tsx`（硬编码 `{en,zh}` 数据的运行时转换）
 *   3. `scripts/i18n-zh-hant.mjs`（构建期 zh-Hant.json 生成 —— 需手动同步，
 *      因为 .mjs 文件不能 import .ts；若在此增删条目请同步该脚本）
 */
export const TERM_OVERRIDES: Record<string, string> = {
  // 港澳日常几乎都写「群」而非港标本字「羣」（微信、报刊、社交媒体一致）
  羣: "群",
};

/** 把 OpenCC 转换结果按 TERM_OVERRIDES 做整字/整词回退 */
export const applyZhHantOverrides = (text: string): string => {
  let out = text;
  for (const [from, to] of Object.entries(TERM_OVERRIDES)) {
    if (from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
};
