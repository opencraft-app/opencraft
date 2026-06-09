#!/usr/bin/env node
/**
 * optimize-source-assets.mjs
 * ──────────────────────────────────────────────────────────────────────────
 * 维护 frontend/src 与 frontend/public 下的位图资源：
 *
 *  1. 扫描所有 .png / .jpg / .jpeg 文件
 *  2. 通过 basename 在所有源代码文本（.ts/.tsx/.js/.jsx/.mjs/.cjs/.css/.scss/.html/.md）
 *     中查找引用，列出未被任何文件引用的"孤儿图片"
 *  3. 可选删除孤儿图片 (--delete-unused)
 *  4. 无损压缩仍被引用的图片：
 *       - PNG：sharp.png({ compressionLevel:9, adaptiveFiltering:true })  纯 zlib
 *       - JPEG：默认跳过（JPEG 重编码必有微小质量损失）；
 *               如确需重新压缩，传 --allow-jpeg-recompress 用 mozjpeg q=95
 *
 * 默认行为：dry-run（只报告，不动文件）
 *
 * 用法：
 *   node scripts/optimize-source-assets.mjs                # dry-run 报告
 *   node scripts/optimize-source-assets.mjs --apply        # 执行压缩（不删除）
 *   node scripts/optimize-source-assets.mjs --apply --delete-unused
 *   node scripts/optimize-source-assets.mjs --apply --delete-unused --allow-jpeg-recompress
 */
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, "..");

const SCAN_ROOTS = ["src", "public"];
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".html", ".md", ".json",
]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "test-results", ".turbo",
]);

// 「不参与未引用判断」白名单：路径前缀（相对 frontend 根目录）。
// 这些目录的图片可能被 import.meta.glob、运行时拼接（如 -en 本地化后缀）等
// 间接引用，静态 basename 扫描会误判。仍参与无损压缩，但永不删除。
const NEVER_DELETE_DIRS = [
  "src/content/docs/images",
];

function isNeverDelete(absImgPath) {
  const rel = path.relative(FRONTEND_ROOT, absImgPath).split(path.sep).join("/");
  return NEVER_DELETE_DIRS.some(p => rel === p || rel.startsWith(p + "/"));
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = !args.has("--apply");
const DELETE_UNUSED = args.has("--delete-unused");
const ALLOW_JPEG = args.has("--allow-jpeg-recompress");

function fmtKB(b) { return (b / 1024).toFixed(1) + " KB"; }
function fmtMB(b) { return (b / 1024 / 1024).toFixed(2) + " MB"; }

async function walk(dir, list = []) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return list; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith("dist-")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, list);
    else if (e.isFile()) list.push(p);
  }
  return list;
}

async function main() {
  console.log(`[mode] ${DRY_RUN ? "DRY-RUN (报告，不写盘)" : "APPLY"}`);
  console.log(`[opts] delete-unused=${DELETE_UNUSED} allow-jpeg-recompress=${ALLOW_JPEG}`);
  console.log(`[root] ${FRONTEND_ROOT}\n`);

  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    await walk(path.join(FRONTEND_ROOT, root), allFiles);
  }
  // 也扫顶层 index.html
  try {
    await stat(path.join(FRONTEND_ROOT, "index.html"));
    allFiles.push(path.join(FRONTEND_ROOT, "index.html"));
  } catch {}

  const images = allFiles.filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  const texts = allFiles.filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()));

  console.log(`[scan] images=${images.length}, source-text-files=${texts.length}\n`);

  // 1) 拼接所有源文件文本
  const corpus = (await Promise.all(
    texts.map(t => readFile(t, "utf8").catch(() => ""))
  )).join("\n");

  // 2) 用 basename 检测引用（哈希命名碰撞概率极低）
  //    NEVER_DELETE_DIRS 下的图片视为"已引用"（仅参与压缩，不参与删除判断）
  const used = new Set();
  const unused = [];
  for (const img of images) {
    if (isNeverDelete(img)) {
      used.add(img);
      continue;
    }
    const base = path.basename(img);
    if (corpus.includes(base)) used.add(img);
    else unused.push(img);
  }

  // ── 报告：孤儿图片 ──────────────────────────────────────────
  let unusedBytes = 0;
  for (const u of unused) {
    const s = await stat(u);
    unusedBytes += s.size;
  }
  console.log(`══ 未引用图片：${unused.length} 个，合计 ${fmtMB(unusedBytes)} ══`);
  if (unused.length) {
    unused
      .sort()
      .forEach(u => console.log(`  - ${path.relative(FRONTEND_ROOT, u)}`));
    console.log("");
  }

  // ── 执行：删除孤儿 ─────────────────────────────────────────
  if (DELETE_UNUSED && !DRY_RUN) {
    for (const u of unused) await unlink(u);
    console.log(`[deleted] ${unused.length} unused images removed.\n`);
  } else if (DELETE_UNUSED && DRY_RUN) {
    console.log(`[dry-run] would delete ${unused.length} unused images.\n`);
  }

  // ── 压缩：仍被引用的 ───────────────────────────────────────
  let bBefore = 0, bAfter = 0, changed = 0, skippedJpeg = 0;
  const targets = DELETE_UNUSED ? Array.from(used) : images;

  for (const img of targets) {
    const ext = path.extname(img).toLowerCase();
    const original = await readFile(img);
    bBefore += original.length;

    if ((ext === ".jpg" || ext === ".jpeg") && !ALLOW_JPEG) {
      bAfter += original.length;
      skippedJpeg++;
      continue;
    }

    let optimized;
    try {
      if (ext === ".png") {
        optimized = await sharp(original, { animated: false })
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toBuffer();
      } else {
        // jpeg with mozjpeg
        optimized = await sharp(original, { animated: false })
          .jpeg({ quality: 95, mozjpeg: true })
          .toBuffer();
      }
    } catch (err) {
      console.warn(`[skip] ${path.relative(FRONTEND_ROOT, img)}: ${err.message}`);
      bAfter += original.length;
      continue;
    }

    if (optimized.length < original.length) {
      if (!DRY_RUN) await writeFile(img, optimized);
      bAfter += optimized.length;
      changed++;
    } else {
      bAfter += original.length;
    }
  }

  const saved = bBefore - bAfter;
  const pct = bBefore > 0 ? (saved / bBefore * 100).toFixed(1) : "0.0";
  console.log(`══ 压缩结果（${DRY_RUN ? "预估" : "实际"}）══`);
  console.log(`  目标图片：${targets.length}`);
  console.log(`  生效优化：${changed}`);
  console.log(`  跳过 JPEG（默认无损模式）：${skippedJpeg}`);
  console.log(`  压缩前：${fmtMB(bBefore)}`);
  console.log(`  压缩后：${fmtMB(bAfter)}`);
  console.log(`  节省：${fmtKB(saved)} (${pct}%)`);
  if (DRY_RUN) console.log(`\n[hint] 加 --apply 执行实际改动；加 --delete-unused 删除孤儿；加 --allow-jpeg-recompress 重压 JPEG`);
}

main().catch(err => { console.error(err); process.exit(1); });
