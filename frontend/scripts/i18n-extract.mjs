#!/usr/bin/env node
/**
 * i18n 文案提取脚本
 * ──────────────────────────────────────────────────────────────
 * 扫描 `src/**\/*.{ts,tsx}` 与 `next-site/**\/*.{ts,tsx}` 内所有
 * `t("中文")` / `rawT("中文")` 调用，为每条中文生成稳定的 hash key，
 * 并为**注册表中登记的每个语种**产出字典：
 *
 *   src/i18n/generated/zh-to-key.json  —— 中文 → hash（运行时反查）
 *   src/i18n/generated/zh-CN.json      —— hash → 中文（i18next 资源）
 *   src/i18n/generated/<语种>.json      —— hash → 译文（保留已翻译值，新增为空）
 *
 * 语种清单来自 `src/i18n/locales.json`，**不在本脚本中硬编码**。
 * 重构前此处硬编码了 en-US 与 id-ID，新增语种需复制整段逻辑；
 * 且因为是纯 JS 无类型保护，漏改不会有任何报错。
 *
 * 规则：
 *   - hash：md5("中文") 取前 8 位，前缀 k_ ，内容驱动稳定不变
 *   - 删除源码后再跑：孤儿 key 从 zh-CN 清除，但译文**保留**在各语种字典中，
 *     防止误删后又补回的场景需要人工重翻
 *   - `--check` 只校验 `translationRequired: true` 的语种；标记为
 *     false 的语种（翻译进行中）不阻塞 CI
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
const NEXT_SITE = join(ROOT, "next-site");
const SOURCE_ROOTS = [SRC, NEXT_SITE];
const I18N_DIR = join(SRC, "i18n");
const OUT_DIR = join(I18N_DIR, "generated");
const LOCALES_CONFIG = join(I18N_DIR, "locales.json");

const CHECK_ONLY = process.argv.includes("--check");

/* ──────────────────────────────────────────────────────────────
 * Locale 注册表装载
 *
 * 直接读 `locales.json`，与 TypeScript 侧共享同一份数据。
 * 之所以用 JSON 而不是 import `locales.config.ts`：本文件是 `.mjs`，
 * 无法 import `.ts`，而 CI 使用的 Node 22.12 剥离 TS 类型仍需实验性 flag。
 * ────────────────────────────────────────────────────────────── */

function loadLocaleDefinitions() {
  if (!existsSync(LOCALES_CONFIG)) {
    console.error(`[i18n-extract] ❌ 找不到 locale 注册表：${LOCALES_CONFIG}`);
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(readFileSync(LOCALES_CONFIG, "utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("注册表应为非空数组");
    }
    return parsed;
  } catch (err) {
    console.error(`[i18n-extract] ❌ 解析 locale 注册表失败：${err.message}`);
    process.exit(1);
  }
}

const localeDefinitions = loadLocaleDefinitions();

/** 基准语种：中文原文字典，由扫描结果直接生成，无需翻译。 */
const BASE_DICT_KEY = "zh-CN";

/**
 * 需要生成译文字典的语种（去重后）。
 *
 * 排除基准语种 `zh-CN`；`zh-SG` 的 i18nKey 指向 `zh-CN`，因此也自然被排除，
 * 不会产生多余的 zh-SG.json。`zh-Hant` 由 `i18n-zh-hant.mjs` 从简体自动
 * 转换生成，此处仅确保其条目存在，不覆盖已有译文。
 */
const targetDictKeys = [
  ...new Set(
    localeDefinitions
      .map((def) => def.i18nKey)
      .filter((key) => key !== BASE_DICT_KEY),
  ),
];

/** 字典 key → 是否纳入 CI 强制校验。 */
const translationRequiredByDictKey = new Map();
for (const def of localeDefinitions) {
  if (def.i18nKey === BASE_DICT_KEY) continue;
  /* 同一字典被多个 locale 引用时，任一要求必填即必填。 */
  const prev = translationRequiredByDictKey.get(def.i18nKey) ?? false;
  translationRequiredByDictKey.set(def.i18nKey, prev || def.translationRequired === true);
}

/** 字典 key → 展示名，用于日志可读性。 */
const displayNameByDictKey = new Map();
for (const def of localeDefinitions) {
  if (!displayNameByDictKey.has(def.i18nKey)) {
    displayNameByDictKey.set(def.i18nKey, def.displayName);
  }
}

/** 递归列出所有 .ts/.tsx 文件，排除 node_modules / i18n 本身 / 测试文件 */
function listSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      /* 跳过 i18n 目录，避免把字典自身当源码扫 */
      if (full === I18N_DIR) continue;
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

const files = SOURCE_ROOTS.flatMap(listSourceFiles);
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

/** 生成基准字典 */
const zhToKey = {};
const zhCN = {};
for (const zh of zhSet) {
  const key = hashZh(zh);
  zhToKey[zh] = key;
  zhCN[key] = zh;
}

const baseKeys = Object.keys(zhCN);

/**
 * 为每个目标语种生成字典：保留已有翻译，新增 key 置空（待人工翻译）。
 * 语种清单来自注册表，新增语种无需修改本脚本。
 */
const dictionaries = new Map();
for (const dictKey of targetDictKeys) {
  const prev = readJson(join(OUT_DIR, `${dictKey}.json`));
  const next = {};
  for (const key of baseKeys) {
    next[key] = prev[key] ?? "";
  }
  dictionaries.set(dictKey, next);
}

/* ── 输出统计 ─────────────────────────────────────────── */

const totalZh = zhSet.size;

console.log(`[i18n-extract] 扫描 ${files.length} 个源文件`);
console.log(`[i18n-extract] 发现 ${totalZh} 条中文文案`);
console.log(`[i18n-extract] 注册表登记 ${targetDictKeys.length} 个待翻译语种`);

/** 收集缺失情况，供 check 与提示复用。 */
const missingByDictKey = new Map();
for (const [dictKey, dict] of dictionaries) {
  const translated = Object.values(dict).filter((v) => v && v.length > 0).length;
  const missing = totalZh - translated;
  missingByDictKey.set(dictKey, missing);

  const name = displayNameByDictKey.get(dictKey) ?? dictKey;
  const required = translationRequiredByDictKey.get(dictKey) ? "必填" : "进行中";
  console.log(
    `[i18n-extract]   ${dictKey} (${name}, ${required}): 已翻译 ${translated} 条，待翻译 ${missing} 条`,
  );
}

/**
 * 已知翻译债务基线（棘轮）。
 *
 * 这些缺口不是 locale 注册表重构引入的，而是此前存在、但被旧版脚本
 * 掩盖的问题——旧脚本只校验 `en-US`，其余语种缺多少都不会失败。
 *
 * 处理原则：不通过关闭 `translationRequired` 掩盖，而是允许不超过
 * 既有缺口数；一旦新增未翻译文案使缺口变大，CI 立即失败。缺口补齐后
 * 应同步下调此处与 `src/i18n/__tests__/dictionaries.test.ts` 中的基线。
 *
 * id-ID 的缺口来自 master 上通道与模型配置相关功能（钉钉 / 企业微信 /
 * QQ / Kimi / 智谱等），应由对应需求负责人补齐。
 */
const KNOWN_TRANSLATION_DEBT = {
  "id-ID": 174,
};

if (CHECK_ONLY) {
  /* CI 场景：仅 translationRequired 的语种参与门禁；
     标记为进行中的语种允许留空，避免阻塞主干开发。 */
  const blocking = [];
  for (const [dictKey, missing] of missingByDictKey) {
    if (!translationRequiredByDictKey.get(dictKey)) continue;
    const allowed = KNOWN_TRANSLATION_DEBT[dictKey] ?? 0;
    if (missing > allowed) blocking.push([dictKey, missing, allowed]);
  }

  if (blocking.length > 0) {
    for (const [dictKey, missing, allowed] of blocking) {
      console.error(
        `[i18n-extract] ❌ ${dictKey} 存在 ${missing} 条未翻译文案，超出已知基线 ${allowed} 条。` +
          `请补齐 src/i18n/generated/${dictKey}.json 中新增文案的翻译。`,
      );
    }
    process.exit(1);
  }

  /* 基线虚高提醒：缺口已补齐但基线未下调时给出提示，避免门禁失去约束力。 */
  for (const [dictKey, allowed] of Object.entries(KNOWN_TRANSLATION_DEBT)) {
    const missing = missingByDictKey.get(dictKey);
    if (missing !== undefined && missing < allowed) {
      console.warn(
        `[i18n-extract] ⚠️ ${dictKey} 实际缺口 ${missing} 已小于基线 ${allowed}，` +
          `请把脚本与 dictionaries.test.ts 中的基线下调为 ${missing}。`,
      );
    }
  }

  console.log(`[i18n-extract] ✅ check 通过`);
  process.exit(0);
}

writeJson(join(OUT_DIR, "zh-to-key.json"), zhToKey);
writeJson(join(OUT_DIR, `${BASE_DICT_KEY}.json`), zhCN);
for (const [dictKey, dict] of dictionaries) {
  writeJson(join(OUT_DIR, `${dictKey}.json`), dict);
}

console.log(`[i18n-extract] ✅ 写入 ${OUT_DIR}`);
for (const [dictKey, missing] of missingByDictKey) {
  if (missing > 0) {
    console.log(
      `[i18n-extract] 请打开 src/i18n/generated/${dictKey}.json 补齐 ${missing} 条空字符串翻译`,
    );
  }
}
