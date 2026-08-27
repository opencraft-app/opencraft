import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TERM_OVERRIDES } from "@/lib/zh-hant-overrides";

/**
 * 一致性守卫：繁体术语校正表 TERM_OVERRIDES 有两份实现镜像 ——
 *   1. src/lib/zh-hant-overrides.ts（本测试直接 import 的 TS 版，供运行时转换）
 *   2. scripts/i18n-zh-hant.mjs（构建期生成 zh-Hant.json 的 Node 脚本）
 *
 * `.mjs` 无法 import `.ts`，两份只能手动同步。这里通过解析 `.mjs` 源码文本
 * 提取其 TERM_OVERRIDES 字面量，与 TS 版逐条比对，防止二者悄悄漂移。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MJS_PATH = resolve(__dirname, "../../../scripts/i18n-zh-hant.mjs");

/** 从 .mjs 源码文本中抽出 `const TERM_OVERRIDES = { ... };` 并解析为对象。 */
function parseMjsTermOverrides(source: string): Record<string, string> {
  const match = source.match(/const\s+TERM_OVERRIDES\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error("在 i18n-zh-hant.mjs 中未找到 TERM_OVERRIDES 字面量");
  }
  const body = match[1];
  const result: Record<string, string> = {};
  // 匹配 `'羣': '群'` / `"羣": "群"` / `羣: '群'` 形式（忽略行内注释）
  const entryRe = /(?:'([^']+)'|"([^"]+)"|([^\s:,{}]+))\s*:\s*(?:'([^']*)'|"([^"]*)")/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const key = m[1] ?? m[2] ?? m[3];
    const value = m[4] ?? m[5] ?? "";
    if (key !== undefined) result[key] = value;
  }
  return result;
}

describe("zh-Hant TERM_OVERRIDES 双写一致性", () => {
  it(".ts 版与 scripts/i18n-zh-hant.mjs 版内容完全一致", () => {
    const source = readFileSync(MJS_PATH, "utf8");
    const mjsOverrides = parseMjsTermOverrides(source);
    expect(mjsOverrides).toEqual(TERM_OVERRIDES);
  });
});
