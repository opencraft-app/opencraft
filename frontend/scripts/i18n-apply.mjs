#!/usr/bin/env node
/**
 * 翻译批量写入工具
 * ──────────────────────────────────────────────────────────────
 * 供翻译工作分批落盘使用。按「中文原文 → 译文」的映射写入指定语种字典，
 * 内部自动完成中文到 hash key 的转换，避免人工对着 hash 编辑字典。
 *
 * 设计要点：
 *   - 只写入已存在于基准字典（zh-CN）的中文；未收录的原文会被报错列出，
 *     防止因错别字或标点差异写进一条永远不会被命中的翻译。
 *   - 默认不覆盖已有译文（避免批次之间互相踩），需覆盖时传 --overwrite。
 *   - 写入后立刻复用 i18n-validate 的占位符规则做自检。
 *
 * 使用：
 *   node scripts/i18n-apply.mjs <语种> <批次JSON文件> [--overwrite]
 *
 * 批次 JSON 格式：
 *   { "中文原文": "译文", ... }
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const GEN_DIR = join(ROOT, "src", "i18n", "generated");

const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}/g;

const args = process.argv.slice(2);
const overwrite = args.includes("--overwrite");
const positional = args.filter((a) => !a.startsWith("--"));
const [dictKey, batchFile] = positional;

if (!dictKey || !batchFile) {
  console.error("用法: node scripts/i18n-apply.mjs <语种> <批次JSON文件> [--overwrite]");
  process.exit(1);
}

function readJson(file) {
  if (!existsSync(file)) {
    console.error(`[i18n-apply] ❌ 文件不存在: ${file}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[i18n-apply] ❌ 解析失败 ${file}: ${err.message}`);
    process.exit(1);
  }
}

function writeJson(file, obj) {
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
  writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

const hashZh = (zh) => "k_" + createHash("md5").update(zh).digest("hex").slice(0, 8);

const placeholdersOf = (text) =>
  (text.match(PLACEHOLDER_RE) ?? []).map((p) => p.replace(/\s/g, "")).sort().join("|");

const dictPath = join(GEN_DIR, `${dictKey}.json`);
const base = readJson(join(GEN_DIR, "zh-CN.json"));
const dict = readJson(dictPath);
const batch = readJson(batchFile);

const notFound = [];
const placeholderMismatch = [];
const skipped = [];
let applied = 0;

for (const [zh, translation] of Object.entries(batch)) {
  const key = hashZh(zh);

  /* 必须是基准字典里真实存在的原文，否则这条翻译永远不会被命中 */
  if (base[key] === undefined) {
    notFound.push(zh);
    continue;
  }

  if (!translation) continue;

  /* 占位符必须与原文一致，否则线上会直接显示 {{xxx}} 字面量 */
  if (placeholdersOf(zh) !== placeholdersOf(translation)) {
    placeholderMismatch.push({ zh, translation });
    continue;
  }

  if (dict[key] && !overwrite) {
    skipped.push(zh);
    continue;
  }

  dict[key] = translation;
  applied += 1;
}

if (notFound.length > 0) {
  console.error(`[i18n-apply] ❌ ${notFound.length} 条原文未收录于 zh-CN 字典（可能有错别字或标点差异）:`);
  for (const zh of notFound.slice(0, 15)) console.error(`    ${JSON.stringify(zh)}`);
  if (notFound.length > 15) console.error(`    …还有 ${notFound.length - 15} 条`);
}

if (placeholderMismatch.length > 0) {
  console.error(`[i18n-apply] ❌ ${placeholderMismatch.length} 条占位符不一致，已跳过:`);
  for (const { zh, translation } of placeholderMismatch.slice(0, 15)) {
    console.error(`    原文: ${zh}`);
    console.error(`    译文: ${translation}`);
  }
}

if (notFound.length > 0 || placeholderMismatch.length > 0) {
  console.error(`[i18n-apply] 未写入任何内容，请修正后重试`);
  process.exit(1);
}

writeJson(dictPath, dict);

const total = Object.keys(base).length;
const done = Object.values(dict).filter((v) => v && v.length > 0).length;

console.log(`[i18n-apply] ✅ ${dictKey}: 本批写入 ${applied} 条${skipped.length ? `，跳过已有 ${skipped.length} 条` : ""}`);
console.log(`[i18n-apply]    进度 ${done}/${total}（剩余 ${total - done} 条）`);
