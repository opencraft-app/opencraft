#!/usr/bin/env node
/**
 * i18n 文案提取脚本
 * ──────────────────────────────────────────────────────────────
 * 扫描 `src/**\/*.{ts,tsx}` 内所有 `t("中文")` / `useT()` 调用，
 * 为每条中文生成稳定的 hash key，产出三份 JSON：
 *
 *   src/i18n/generated/zh-to-key.json  —— 中文 → hash（运行时反查）
 *   src/i18n/generated/zh-CN.json      —— hash → 中文（i18next 资源）
 *   src/i18n/generated/en-US.json      —— hash → 英文（保留已翻译值，新增为空）
 *
 * 规则：
 *   - hash：md5("中文") 取前 8 位，前缀 k_ ，内容驱动稳定不变
 *   - 删除源码后再跑：孤儿 key 从 zh-CN 清除，但英文翻译**保留**在 en-US
 *     防止误删后又补回的场景需要人工重翻
 *
 * 使用：
 *   node scripts/i18n-extract.mjs          # 全量扫描并写盘
 *   node scripts/i18n-extract.mjs --check  # 只检查，不写盘（CI 可用）
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const OUT_DIR = join(SRC, "i18n", "generated");

const CHECK_ONLY = process.argv.includes("--check");

/** 递归列出所有 .ts/.tsx 文件，排除 node_modules / i18n 本身 / 测试文件 */
function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      /* 跳过 i18n 目录，避免把字典自身当源码扫 */
      if (full === join(SRC, "i18n")) continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 从源码里提取 t("中文") / t('中文') / t(`中文`) / rawT("中文") 调用。
 * 为避免误匹配其他同名 t（比如 mathjs 之类），要求整段字符串**包含至少一个汉字**。
 * 说明：rawT 是 i18n 模块导出的命令式翻译函数（用于非 React 上下文），
 * 与 React Hook 的 t 语义一致，必须一并被字典收录。
 */
const CJK_RE = /[\u4e00-\u9fff]/;
const T_CALL_RE = /(?<![\w$])(?:rawT|t)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

function extractFromFile(file) {
  const content = readFileSync(file, "utf8");
  const hits = [];
  let m;
  while ((m = T_CALL_RE.exec(content)) !== null) {
    const raw = m[2];
    if (!CJK_RE.test(raw)) continue;
    /* 反斜杠转义还原（主要是 \" \' \\ \n） */
    const zh = raw
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
    hits.push(zh);
  }
  return hits;
}

function hashZh(zh) {
  return "k_" + createHash("md5").update(zh).digest("hex").slice(0, 8);
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    const text = readFileSync(file, "utf8").trim();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  /* 按 key 排序输出，diff 友好 */
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
  writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

/* ── 主流程 ───────────────────────────────────────────── */

const files = listSourceFiles(SRC);
/** 所有中文原文去重集合 */
const zhSet = new Set();
/** 便于排查：记录每条中文来自哪些文件 */
const zhToFiles = new Map();

for (const file of files) {
  const hits = extractFromFile(file);
  for (const zh of hits) {
    zhSet.add(zh);
    const rel = relative(ROOT, file);
    if (!zhToFiles.has(zh)) zhToFiles.set(zh, new Set());
    zhToFiles.get(zh).add(rel);
  }
}

/** 生成新的字典 */
const zhToKey = {};
const zhCN = {};
for (const zh of zhSet) {
  const key = hashZh(zh);
  zhToKey[zh] = key;
  zhCN[key] = zh;
}

/** 英文字典：保留已有翻译，新增 key 置空（待人工翻译） */
const prevEnPath = join(OUT_DIR, "en-US.json");
const prevEn = readJson(prevEnPath);
const enUS = {};
for (const key of Object.keys(zhCN)) {
  enUS[key] = prevEn[key] ?? "";
}

/* ── 输出统计 ─────────────────────────────────────────── */

const totalZh = zhSet.size;
const translatedEn = Object.values(enUS).filter((v) => v && v.length > 0).length;
const missingEn = totalZh - translatedEn;

console.log(`[i18n-extract] 扫描 ${files.length} 个源文件`);
console.log(`[i18n-extract] 发现 ${totalZh} 条中文文案`);
console.log(`[i18n-extract] 英文已翻译 ${translatedEn} 条，待翻译 ${missingEn} 条`);

if (CHECK_ONLY) {
  /* CI 场景：英文有缺失则以非零退出码失败 */
  if (missingEn > 0) {
    console.error(`[i18n-extract] ❌ 存在 ${missingEn} 条未翻译文案，请运行 pnpm i18n:extract 后补齐 en-US.json`);
    process.exit(1);
  }
  console.log(`[i18n-extract] ✅ check 通过`);
  process.exit(0);
}

writeJson(join(OUT_DIR, "zh-to-key.json"), zhToKey);
writeJson(join(OUT_DIR, "zh-CN.json"), zhCN);
writeJson(join(OUT_DIR, "en-US.json"), enUS);

console.log(`[i18n-extract] ✅ 写入 ${OUT_DIR}`);
if (missingEn > 0) {
  console.log(`[i18n-extract] 请打开 src/i18n/generated/en-US.json 补齐空字符串翻译`);
}
