#!/usr/bin/env node
/**
 * prune-unused-decls.mjs
 * ──────────────────────────────────────────────────────────────────────────
 * 一次性脚本：对 imports/Frame2147230025/sections/* 内被 TS6133 标记的
 * 未使用 import specifier 与顶层 function/variable 声明做精确删除。
 *
 * 流程：
 *   1. 解析参数 / 默认目标列表
 *   2. 临时移除每个文件的 // @ts-nocheck（如果有）
 *   3. 跑 tsc，拿到所有 TS6133 → 按 (file, identifier) 收集
 *   4. 对每个文件用 typescript AST 找到节点：
 *        - 删除 named ImportSpecifier（同 import 全空时连整条 import 一起删）
 *        - 删除整个 FunctionDeclaration / VariableStatement / InterfaceDeclaration
 *   5. 应用 ranges（从后往前 splice 文本，保持其它部分原貌）
 *   6. 清理因删除产生的多余逗号 / 空行
 *   7. 二次 tsc 验证：若仍有 TS6133，报告并退出非零；否则成功
 *
 * 用法：
 *   node scripts/prune-unused-decls.mjs                       # 默认目标
 *   node scripts/prune-unused-decls.mjs --dry-run             # 只报告不写盘
 *   node scripts/prune-unused-decls.mjs --files a.tsx,b.tsx   # 自定义目标
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const filesArgIdx = args.indexOf("--files");
const explicitFiles = filesArgIdx >= 0
  ? args[filesArgIdx + 1].split(",").map(p => path.resolve(FRONTEND_ROOT, p))
  : [
      "src/imports/Frame2147230025/sections/BrandIconsSection.tsx",
      "src/imports/Frame2147230025/sections/CtaSection.tsx",
      "src/imports/Frame2147230025/sections/FeatureSection.tsx",
      "src/imports/Frame2147230025/sections/FooterSection.tsx",
      "src/imports/Frame2147230025/sections/HeaderSection.tsx",
      "src/imports/Frame2147230025/sections/HeroSection.tsx",
      "src/imports/Frame2147230025/sections/ProcessSection.tsx",
      "src/imports/Frame2147230025/svg-2luot.tsx",
    ].map(p => path.resolve(FRONTEND_ROOT, p));

function rel(p) { return path.relative(FRONTEND_ROOT, p).split(path.sep).join("/"); }

function stripTsNocheck(file) {
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("// @ts-nocheck")) return false;
  const newline = text.indexOf("\n");
  writeFileSync(file, text.slice(newline + 1), "utf8");
  return true;
}

function runTscAndCollectErrors() {
  let out;
  try {
    out = execSync("pnpm -s check 2>&1", {
      cwd: FRONTEND_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    out = err.stdout || "";
  }
  const RE = /^(.+?)\((\d+),(\d+)\):\s*error TS6133:\s*'([^']+)'/;
  const byFile = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(RE);
    if (!m) continue;
    const [, file, ln, col, name] = m;
    const abs = path.resolve(FRONTEND_ROOT, file);
    if (!byFile.has(abs)) byFile.set(abs, new Set());
    byFile.get(abs).add(name);
  }
  return byFile;
}

function pruneFile(filePath, unusedNames) {
  const original = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, original, ts.ScriptTarget.Latest, true);

  /** 待删除的源代码区间，每项 {start, end, why} */
  const ranges = [];

  function pushRange(start, end, why) {
    ranges.push({ start, end, why });
  }

  function nodeFullEnd(node) {
    // 跳过节点末尾的换行
    let end = node.getEnd();
    while (end < original.length && (original[end] === "\n" || original[end] === "\r")) end++;
    return end;
  }

  function nodeFullStart(node) {
    return node.getStart(sf, /* includeJSDoc */ true);
  }

  function visit(node) {
    // 1) ImportDeclaration
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        const keepers = elements.filter(e => !unusedNames.has(e.name.text));
        const droppers = elements.filter(e => unusedNames.has(e.name.text));
        const defaultName = clause.name?.text;
        const defaultDropped = defaultName && unusedNames.has(defaultName);

        if (
          keepers.length === 0 &&
          (defaultDropped || !defaultName) &&
          (!clause.namedBindings.elements.length || elements.every(e => unusedNames.has(e.name.text)))
        ) {
          // 整条 import 全部未使用：删整条
          pushRange(nodeFullStart(node), nodeFullEnd(node), `import * (${droppers.map(e => e.name.text).join(", ")})`);
          return;
        }

        // 删除部分 specifier
        for (const el of droppers) {
          // 区间扩到与左侧逗号一并消除（若是首个则与右侧逗号一并消除）
          const start = el.getFullStart();
          const end = el.getEnd();
          // 从源码看左右最近 ',' 和 '{' '}' 边界
          let leftScan = start - 1;
          while (leftScan > 0 && /[\s\n\r]/.test(original[leftScan])) leftScan--;
          let rightScan = end;
          while (rightScan < original.length && /[\s\n\r]/.test(original[rightScan])) rightScan++;
          let segStart = start;
          let segEnd = end;
          if (original[leftScan] === ",") {
            segStart = leftScan; // 包含左逗号
          } else if (original[rightScan] === ",") {
            segEnd = rightScan + 1; // 包含右逗号
          }
          pushRange(segStart, segEnd, `import-specifier ${el.name.text}`);
        }

        // 处理 default import 未用但 named 全留的情况
        if (defaultDropped && keepers.length > 0) {
          // 删 default 名 + 后面的逗号空格直到 '{'
          const defStart = clause.name.getStart(sf);
          const defEnd = clause.name.getEnd();
          let scan = defEnd;
          while (scan < original.length && /[\s,]/.test(original[scan])) scan++;
          pushRange(defStart, scan, `default-import ${defaultName}`);
        }
      }
      return;
    }

    // 2) FunctionDeclaration / VariableStatement / InterfaceDeclaration / TypeAliasDeclaration
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text;
      if (name && unusedNames.has(name)) {
        pushRange(nodeFullStart(node), nodeFullEnd(node), `function ${name}`);
      }
      return;
    }
    if (ts.isVariableStatement(node)) {
      const decls = node.declarationList.declarations;
      // 简化：只处理仅一个声明的情况
      if (decls.length === 1) {
        const d = decls[0];
        if (ts.isIdentifier(d.name) && unusedNames.has(d.name.text)) {
          pushRange(nodeFullStart(node), nodeFullEnd(node), `const ${d.name.text}`);
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name?.text;
      if (name && unusedNames.has(name)) {
        pushRange(nodeFullStart(node), nodeFullEnd(node), `type ${name}`);
      }
      return;
    }
  }

  // 仅顶层
  ts.forEachChild(sf, visit);

  if (ranges.length === 0) {
    return { changed: false, removedCount: 0 };
  }

  // 从后往前 splice
  ranges.sort((a, b) => b.start - a.start);
  let updated = original;
  for (const r of ranges) {
    updated = updated.slice(0, r.start) + updated.slice(r.end);
  }

  // 收尾清理：连续逗号 / 空白逗号
  updated = updated
    .replace(/,(\s*,)+/g, ",")
    .replace(/\{\s*,/g, "{")
    .replace(/,\s*\}/g, " }")
    // 空 named imports：`import {} from '...'`
    .replace(/^\s*import\s*\{\s*\}\s*from\s*['"][^'"]+['"];?\s*\n/gm, "")
    // 三连空行收敛为两行
    .replace(/\n{3,}/g, "\n\n");

  if (DRY_RUN) {
    console.log(`[dry-run] ${rel(filePath)}: would remove ${ranges.length} segment(s)`);
    for (const r of ranges) console.log(`    - ${r.why}`);
  } else {
    writeFileSync(filePath, updated, "utf8");
  }

  return { changed: !DRY_RUN, removedCount: ranges.length };
}

// ── main ────────────────────────────────────────────────────────────────
console.log(`[step 1] strip @ts-nocheck`);
let stripped = 0;
for (const f of explicitFiles) {
  if (stripTsNocheck(f)) {
    stripped++;
    console.log(`  - ${rel(f)}`);
  }
}
console.log(`  stripped: ${stripped} file(s)`);

console.log(`\n[step 2] run tsc to enumerate TS6133 unused identifiers`);
const errs = runTscAndCollectErrors();
let total = 0;
for (const [f, names] of errs) {
  total += names.size;
  console.log(`  ${rel(f)}: ${names.size}`);
}
console.log(`  total unused identifiers: ${total}`);

if (total === 0) {
  console.log(`\n[done] nothing to prune.`);
  process.exit(0);
}

console.log(`\n[step 3] prune ${DRY_RUN ? "(dry-run)" : "(write)"}`);
for (const file of explicitFiles) {
  if (!errs.has(file)) continue;
  const result = pruneFile(file, errs.get(file));
  console.log(`  ${rel(file)}: removed ${result.removedCount} segment(s)`);
}

if (DRY_RUN) {
  console.log(`\n[done] dry-run complete; rerun without --dry-run to apply.`);
  process.exit(0);
}

console.log(`\n[step 4] verify with tsc`);
const remain = runTscAndCollectErrors();
let remainTotal = 0;
for (const names of remain.values()) remainTotal += names.size;
if (remainTotal === 0) {
  console.log(`  ✓ tsc clean: 0 TS6133 errors remaining`);
  process.exit(0);
} else {
  console.log(`  ⚠ remaining: ${remainTotal} (manual fix may be needed)`);
  for (const [f, names] of remain) {
    console.log(`    ${rel(f)}: ${[...names].join(", ")}`);
  }
  process.exit(1);
}
