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
 * 用法：
 *   node scripts/i18n-zh-hant.mjs           生成/覆盖 zh-Hant.json（pnpm i18n:zh-hant）
 *   node scripts/i18n-zh-hant.mjs --check    仅校验，不落盘（pnpm i18n:zh-hant:check）
 *
 * --check 模式（CI 守卫）：
 *   以当前 zh-CN.json 为源重跑转换，与磁盘上的 zh-Hant.json 逐条比对：
 *     · key 集必须完全一致（zh-CN 新增文案后忘跑本脚本 → 繁体缺 key，会被拦下）
 *     · 每个 value 必须等于重跑转换结果（避免 zh-Hant.json 被手改后与转换规则漂移）
 *   任一不符则打印差异并以非零码退出，供 CI（pnpm check 前置）拦截。
 * ─────────────────────────────────────────────
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * 以 zh-CN.json 为源，做 OpenCC 简→繁 + 术语校正，返回 { hash: 繁體 } 映射。
 * 纯函数，不触碰磁盘输出，供「生成」与「--check 校验」两条路径复用。
 */
function buildZhHant(zhCN) {
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
  return { zhHant, converted };
}

/** 序列化为最终落盘格式（稳定缩进 + 结尾换行），供写入与比对共用。 */
function serialize(map) {
  return `${JSON.stringify(map, null, 2)}\n`;
}

function readZhCN() {
  const raw = readFileSync(SRC_FILE, 'utf8');
  return JSON.parse(raw);
}

/** 生成模式：重跑转换并写入 zh-Hant.json。 */
function runGenerate() {
  const zhCN = readZhCN();
  const { zhHant, converted } = buildZhHant(zhCN);
  writeFileSync(OUT_FILE, serialize(zhHant), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[i18n:zh-hant] 生成 ${OUT_FILE}，共 ${converted} 条文案。`);
}

/**
 * 校验模式（CI）：不落盘，比对磁盘 zh-Hant.json 与「重跑转换结果」。
 * 差异分三类打印，任一存在即以退出码 1 结束。
 */
function runCheck() {
  if (!existsSync(OUT_FILE)) {
    // eslint-disable-next-line no-console
    console.error(
      `[i18n:zh-hant] ✗ 找不到 ${OUT_FILE}，请先运行 \`pnpm i18n:zh-hant\` 生成。`,
    );
    process.exit(1);
  }

  const zhCN = readZhCN();
  const { zhHant: expected } = buildZhHant(zhCN);
  /** @type {Record<string, string>} */
  const actual = JSON.parse(readFileSync(OUT_FILE, 'utf8'));

  const expectedKeys = new Set(Object.keys(expected));
  const actualKeys = new Set(Object.keys(actual));

  const missingKeys = [...expectedKeys].filter((k) => !actualKeys.has(k)); // zh-CN 有、繁体缺
  const staleKeys = [...actualKeys].filter((k) => !expectedKeys.has(k)); // 繁体多出（zh-CN 已删）
  const mismatched = [...expectedKeys].filter(
    (k) => actualKeys.has(k) && actual[k] !== expected[k],
  );

  if (missingKeys.length === 0 && staleKeys.length === 0 && mismatched.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[i18n:zh-hant] ✓ zh-Hant.json 与 zh-CN.json 转换结果一致（${expectedKeys.size} 条）。`,
    );
    return;
  }

  /* eslint-disable no-console */
  console.error('[i18n:zh-hant] ✗ zh-Hant.json 已过期，请运行 `pnpm i18n:zh-hant` 重新生成。');
  if (missingKeys.length) {
    console.error(`\n  缺失 ${missingKeys.length} 条（zh-CN 新增但繁体未生成）：`);
    for (const k of missingKeys.slice(0, 20)) console.error(`    - ${k}: "${expected[k]}"`);
    if (missingKeys.length > 20) console.error(`    …… 其余 ${missingKeys.length - 20} 条略`);
  }
  if (staleKeys.length) {
    console.error(`\n  多余 ${staleKeys.length} 条（zh-CN 已删除但繁体残留）：`);
    for (const k of staleKeys.slice(0, 20)) console.error(`    - ${k}`);
    if (staleKeys.length > 20) console.error(`    …… 其余 ${staleKeys.length - 20} 条略`);
  }
  if (mismatched.length) {
    console.error(`\n  内容不一致 ${mismatched.length} 条（与当前转换规则漂移）：`);
    for (const k of mismatched.slice(0, 20)) {
      console.error(`    - ${k}: 期望 "${expected[k]}" 实为 "${actual[k]}"`);
    }
    if (mismatched.length > 20) console.error(`    …… 其余 ${mismatched.length - 20} 条略`);
  }
  /* eslint-enable no-console */
  process.exit(1);
}

function main() {
  const isCheck = process.argv.includes('--check');
  if (isCheck) {
    runCheck();
  } else {
    runGenerate();
  }
}

main();
