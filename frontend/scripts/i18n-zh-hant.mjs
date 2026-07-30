// scripts/i18n-zh-hant.mjs
/**
 * 繁體中文（zh-Hant）文案生成脚本
 * ─────────────────────────────────────────────
 * 作用：以简体 `zh-CN.json`（hash → 简体中文）为源，做简→繁转换，
 *       生成 `zh-Hant.json`（hash → 繁體中文），供国际站官网繁体使用。
 *
 * 转换链路：
 *   1. OpenCC `cn → hk`（香港繁體標準字形，仅做字形简→繁，不做台湾词汇替换，
 *      因此保留港式用词，如「文档→文檔」「软件→軟件」「网络→網絡」，而非台湾的「文件/軟體/網路」）
 *   2. 叠加术语校正表 TERM_OVERRIDES：统一品牌/技术用词，修正机转偏差
 *
 * 只转换字典 value（汉字），key（hash）与英文、占位符 {{x}} 均原样保留。
 *
 * 用法：node scripts/i18n-zh-hant.mjs  (或 pnpm i18n:zh-hant)
 * ─────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as OpenCC from 'opencc-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = resolve(__dirname, '../src/i18n/generated');
const SRC_FILE = resolve(GENERATED_DIR, 'zh-CN.json');
const OUT_FILE = resolve(GENERATED_DIR, 'zh-Hant.json');

/**
 * 术语校正表（在 OpenCC 转换「之后」执行的整词替换）。
 * key 为 OpenCC 输出中可能出现的繁体词，value 为最终采用的香港惯用/品牌统一写法。
 *
 * 注意：繁體站采用「香港用语」而非台湾用语，因此不做台湾词汇替换：
 *   - 保留「網絡 / 軟件 / 視頻 / 智能 / 信息」，不要转成台湾的「網路 / 軟體 / 影片 / 智慧 / 資訊」
 *   - 「文檔」保持「文檔」，不转成台湾的「文件」（OpenCC hk 模式已默认如此）
 *
 * ⚠️ 该表需与 `src/lib/zh-hant-overrides.ts` 保持一致 —— 若在此增删条目，
 *    请同步修改 TS 版本，反之亦然（.mjs 无法 import .ts，所以只能手动同步）。
 */
const TERM_OVERRIDES = {
  // 港澳日常几乎都写「群」而非港标本字「羣」（微信、报刊、社交媒体一致）
  '羣': '群',
};

function applyOverrides(text) {
  let out = text;
  for (const [from, to] of Object.entries(TERM_OVERRIDES)) {
    if (from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

function main() {
  const raw = readFileSync(SRC_FILE, 'utf8');
  /** @type {Record<string, string>} */
  const zhCN = JSON.parse(raw);

  const convert = OpenCC.Converter({ from: 'cn', to: 'hk' });

  /** @type {Record<string, string>} */
  const zhHant = {};
  let converted = 0;
  for (const [key, value] of Object.entries(zhCN)) {
    if (typeof value !== 'string') {
      zhHant[key] = value;
      continue;
    }
    zhHant[key] = applyOverrides(convert(value));
    converted += 1;
  }

  writeFileSync(OUT_FILE, `${JSON.stringify(zhHant, null, 2)}\n`, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[i18n:zh-hant] 生成 ${OUT_FILE}，共 ${converted} 条文案。`);
}

main();
