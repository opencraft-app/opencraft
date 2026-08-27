#!/usr/bin/env node
/**
 * i18n 字典校验脚本
 * ──────────────────────────────────────────────────────────────
 * 校验各语种字典的**结构正确性**（而非翻译质量），防止人工或批量
 * 翻译过程中破坏运行时行为。
 *
 * 校验项：
 *   1. 占位符一致性：`{{name}}` 等插值变量必须与中文原文完全一致。
 *      漏写会导致界面显示不出变量值，写错会导致 i18next 原样输出
 *      `{{xxx}}` 字面量——两者都是线上可见的 bug。
 *   2. 换行结构：原文含 `\n` 的文案（多为标题分行排版）译文也应保留，
 *      否则排版会塌成一行。
 *   3. HTML 标签配对：含 `<a>` 等标签的文案，标签数量需一致，
 *      避免翻译时吞掉标签导致链接失效或 DOM 结构损坏。
 *   4. 未翻译残留：译文与中文原文完全相同且含汉字时，视为漏翻
 *      （仅对已声明翻译完成的语种告警）。
 *   5. 可疑空白：首尾空格差异容易在拼接场景造成显示异常。
 *
 * 使用：
 *   node scripts/i18n-validate.mjs            # 校验全部语种
 *   node scripts/i18n-validate.mjs es ja-JP   # 只校验指定语种
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const I18N_DIR = join(ROOT, "src", "i18n");
const GEN_DIR = join(I18N_DIR, "generated");
const LOCALES_CONFIG = join(I18N_DIR, "locales.json");

const BASE_DICT_KEY = "zh-CN";
const CJK_RE = /[\u4e00-\u9fff]/;
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[i18n-validate] ❌ 解析失败 ${file}: ${err.message}`);
    process.exit(1);
  }
}

/** 提取并排序占位符，用于集合比较（顺序可因语法差异而不同，故排序）。 */
function placeholdersOf(text) {
  const found = text.match(PLACEHOLDER_RE) ?? [];
  return found.map((p) => p.replace(/\s/g, "")).sort();
}

function htmlTagCountOf(text) {
  return (text.match(HTML_TAG_RE) ?? []).length;
}

function newlineCountOf(text) {
  return (text.match(/\n/g) ?? []).length;
}

/* ── 装载 ─────────────────────────────────────────────── */

const localeDefs = readJson(LOCALES_CONFIG);
if (!Array.isArray(localeDefs)) {
  console.error(`[i18n-validate] ❌ 找不到或无法解析 ${LOCALES_CONFIG}`);
  process.exit(1);
}

const base = readJson(join(GEN_DIR, `${BASE_DICT_KEY}.json`));
if (!base) {
  console.error(`[i18n-validate] ❌ 缺少基准字典 ${BASE_DICT_KEY}.json`);
  process.exit(1);
}

const requestedLocales = process.argv.slice(2).filter((a) => !a.startsWith("-"));

/** 需要校验的字典 key（去重，排除基准语种）。 */
const dictKeys = [
  ...new Set(localeDefs.map((d) => d.i18nKey).filter((k) => k !== BASE_DICT_KEY)),
].filter((k) => requestedLocales.length === 0 || requestedLocales.includes(k));

if (dictKeys.length === 0) {
  console.error(`[i18n-validate] ❌ 没有匹配的语种，可选值：`);
  console.error(
    `  ${[...new Set(localeDefs.map((d) => d.i18nKey).filter((k) => k !== BASE_DICT_KEY))].join(", ")}`,
  );
  process.exit(1);
}

const translationRequired = new Map(
  localeDefs.map((d) => [d.i18nKey, d.translationRequired === true]),
);

/* ── 校验 ─────────────────────────────────────────────── */

let totalErrors = 0;
let totalWarnings = 0;

for (const dictKey of dictKeys) {
  const dict = readJson(join(GEN_DIR, `${dictKey}.json`));
  if (!dict) {
    console.error(`[i18n-validate] ❌ ${dictKey}: 字典文件不存在`);
    totalErrors += 1;
    continue;
  }

  const errors = [];
  const warnings = [];
  let translated = 0;

  for (const [key, zh] of Object.entries(base)) {
    const value = dict[key];

    if (value === undefined) {
      errors.push(`缺少 key ${key}（原文：${zh.slice(0, 30)}）`);
      continue;
    }
    if (!value) continue; /* 空值 = 待翻译，由 i18n-extract 统计，不在此报错 */

    translated += 1;

    /* 1. 占位符必须完全一致 */
    const zhPlaceholders = placeholdersOf(zh);
    const valuePlaceholders = placeholdersOf(value);
    if (zhPlaceholders.join("|") !== valuePlaceholders.join("|")) {
      errors.push(
        `占位符不一致 ${key}\n      原文: ${zh}\n      译文: ${value}\n` +
          `      原文占位符 [${zhPlaceholders.join(", ")}] vs 译文 [${valuePlaceholders.join(", ")}]`,
      );
    }

    /* 2. 换行结构应保留（排版相关） */
    if (newlineCountOf(zh) !== newlineCountOf(value)) {
      warnings.push(
        `换行数不一致 ${key}（原文 ${newlineCountOf(zh)} 个，译文 ${newlineCountOf(value)} 个）` +
          `\n      原文: ${JSON.stringify(zh.slice(0, 40))}`,
      );
    }

    /* 3. HTML 标签数量应一致 */
    if (htmlTagCountOf(zh) !== htmlTagCountOf(value)) {
      errors.push(
        `HTML 标签数不一致 ${key}（原文 ${htmlTagCountOf(zh)} 个，译文 ${htmlTagCountOf(value)} 个）`,
      );
    }

    /* 4. 未翻译残留：译文与原文完全相同且含汉字。
       跳过 zh-Hant：简繁体本就有大量同形字（「管理」「季付」等），
       相同不代表漏翻，对其告警只会产生 200+ 条噪音并掩盖真实问题。
       繁体字典由 i18n-zh-hant.mjs 从简体自动转换并有独立 check。 */
    if (dictKey !== "zh-Hant" && value === zh && CJK_RE.test(value)) {
      /* 少数文案本身就是中文品牌名（如「元宝」），不应误报为错误，故用告警 */
      warnings.push(`译文与中文原文相同 ${key}: ${zh.slice(0, 40)}`);
    }

    /* 5. 首尾空白差异。
       仅当「原文无首尾空白但译文有」时告警——反之是常见且合理的：
       中文拼接不需要空格，而英文等语种需要（如 "Click " + 按钮名）。 */
    if (zh === zh.trim() && value !== value.trim()) {
      warnings.push(
        `译文有首尾空白但原文没有 ${key}: ${JSON.stringify(value.slice(0, 30))}` +
          `（若为拼接场景所需可忽略）`,
      );
    }
  }

  const required = translationRequired.get(dictKey) ? "必填" : "进行中";
  const status = errors.length > 0 ? "❌" : warnings.length > 0 ? "⚠️" : "✅";
  console.log(
    `[i18n-validate] ${status} ${dictKey} (${required}): ` +
      `已翻译 ${translated}/${Object.keys(base).length}，` +
      `错误 ${errors.length}，告警 ${warnings.length}`,
  );

  for (const e of errors.slice(0, 20)) console.error(`    ERROR  ${e}`);
  if (errors.length > 20) console.error(`    …还有 ${errors.length - 20} 个错误`);
  for (const w of warnings.slice(0, 10)) console.warn(`    WARN   ${w}`);
  if (warnings.length > 10) console.warn(`    …还有 ${warnings.length - 10} 个告警`);

  totalErrors += errors.length;
  totalWarnings += warnings.length;
}

console.log(
  `[i18n-validate] 汇总：错误 ${totalErrors} 个，告警 ${totalWarnings} 个`,
);

if (totalErrors > 0) {
  console.error(`[i18n-validate] ❌ 存在结构性错误，会导致线上文案异常，必须修复`);
  process.exit(1);
}

console.log(`[i18n-validate] ✅ 结构校验通过`);
