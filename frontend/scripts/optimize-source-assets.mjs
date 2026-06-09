#!/usr/bin/env node
/**
 * optimize-source-assets.mjs
 * ──────────────────────────────────────────────────────────────────────────
 * 维护 frontend/src 与 frontend/public 下的位图资源：
 *
 *   STEP 1  Prune dead re-exports
 *           扫描 src/imports/** /assets.{ts,tsx}，解析
 *               export { default as <name> } from "./<file>";
 *           检查 <name> 是否在该 assets 文件之外的源码中被使用；
 *           未使用的视为「死 re-export」。
 *           --apply 时：
 *             a. 在 assets 文件中删除该行
 *             b. 若引用的是图片，则同步删除该图片文件
 *
 *   STEP 2  Detect & delete orphan images
 *           对剩余图片（含未通过 assets.ts 引用的，如 public/）
 *           用 basename 在源代码 corpus 中查找；零命中即孤儿。
 *           NEVER_DELETE_DIRS 下的图片仅压缩、不删除。
 *
 *   STEP 3  Lossless compression
 *             - PNG   sharp.png({ compressionLevel:9, adaptiveFiltering:true })
 *             - JPEG  默认跳过；--allow-jpeg-recompress 才用 mozjpeg q=95
 *
 * 用法：
 *   node scripts/optimize-source-assets.mjs                # dry-run 报告
 *   node scripts/optimize-source-assets.mjs --apply        # 仅压缩
 *   node scripts/optimize-source-assets.mjs --apply --delete-unused
 *   node scripts/optimize-source-assets.mjs --apply --delete-unused --allow-jpeg-recompress
 *
 *   --no-prune-dead-exports   关闭 STEP 1（默认开启）
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
const PRUNE_DEAD_EXPORTS = !args.has("--no-prune-dead-exports");

function fmtKB(b) { return (b / 1024).toFixed(1) + " KB"; }
function fmtMB(b) { return (b / 1024 / 1024).toFixed(2) + " MB"; }
function rel(p) { return path.relative(FRONTEND_ROOT, p).split(path.sep).join("/"); }

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

/**
 * 解析单个 assets.ts，返回 [{ line, varName, refPath }] 列表。
 * 仅匹配 `export { default as X } from "./Y";` 模式；其它 export 行不动。
 */
function parseAssetsFile(content) {
  const lines = content.split(/\r?\n/);
  const RE = /^\s*export\s*\{\s*default\s+as\s+(\w+)\s*\}\s*from\s+["'](\.\/[^"']+)["'];?\s*$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RE);
    if (m) out.push({ lineIdx: i, varName: m[1], refPath: m[2] });
  }
  return out;
}

/** STEP 1: 扫描 imports/** /assets.{ts,tsx}，删死 re-export 与对应图片 */
async function pruneDeadExports(allTexts) {
  const assetsFiles = allTexts.filter(t =>
    /\/imports\/[^/]+\/assets\.(ts|tsx)$/.test(rel(t))
  );
  if (assetsFiles.length === 0) {
    console.log("[step 1] no imports/*/assets.ts found, skip dead-export pruning.\n");
    return { deletedImages: [], rewrittenAssets: [] };
  }

  // 收集 assets.ts 之外所有源文本，作为变量使用情况的检测语料
  const otherTexts = allTexts.filter(t => !assetsFiles.includes(t));
  const corpus = (await Promise.all(
    otherTexts.map(t => readFile(t, "utf8").catch(() => ""))
  )).join("\n");

  let totalDead = 0;
  const deletedImages = [];
  const rewrittenAssets = [];

  for (const af of assetsFiles) {
    const content = await readFile(af, "utf8");
    const entries = parseAssetsFile(content);
    if (entries.length === 0) continue;

    const dead = entries.filter(e => {
      const re = new RegExp(`\\b${e.varName}\\b`);
      return !re.test(corpus);
    });

    if (dead.length === 0) continue;
    totalDead += dead.length;

    console.log(`[step 1] ${rel(af)}: ${dead.length} dead re-exports`);
    for (const d of dead) {
      const refAbs = path.resolve(path.dirname(af), d.refPath);
      const isImage = IMAGE_EXT.has(path.extname(refAbs).toLowerCase());
      const exists = await stat(refAbs).then(() => true).catch(() => false);
      const sizeStr = isImage && exists
        ? ` (${fmtKB((await stat(refAbs)).size)})`
        : "";
      console.log(`    - ${d.varName} → ${d.refPath}${isImage ? " [image]" : ""}${sizeStr}`);
      if (!DRY_RUN && isImage && exists) {
        await unlink(refAbs);
        deletedImages.push(refAbs);
      }
    }

    if (!DRY_RUN) {
      const lines = content.split(/\r?\n/);
      const removeSet = new Set(dead.map(d => d.lineIdx));
      const newLines = lines.filter((_, i) => !removeSet.has(i));
      await writeFile(af, newLines.join("\n"), "utf8");
      rewrittenAssets.push(af);
    }
  }

  if (totalDead === 0) {
    console.log("[step 1] no dead re-exports found.\n");
  } else {
    console.log(`[step 1] ${DRY_RUN ? "would prune" : "pruned"} ${totalDead} dead re-export(s) across ${assetsFiles.length} assets file(s).\n`);
  }

  return { deletedImages, rewrittenAssets };
}

async function main() {
  console.log(`[mode] ${DRY_RUN ? "DRY-RUN (报告，不写盘)" : "APPLY"}`);
  console.log(`[opts] delete-unused=${DELETE_UNUSED} prune-dead-exports=${PRUNE_DEAD_EXPORTS} allow-jpeg-recompress=${ALLOW_JPEG}`);
  console.log(`[root] ${FRONTEND_ROOT}\n`);

  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    await walk(path.join(FRONTEND_ROOT, root), allFiles);
  }
  try {
    await stat(path.join(FRONTEND_ROOT, "index.html"));
    allFiles.push(path.join(FRONTEND_ROOT, "index.html"));
  } catch {}

  let images = allFiles.filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  const texts = allFiles.filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()));
  console.log(`[scan] images=${images.length}, source-text-files=${texts.length}\n`);

  // ── STEP 1: prune dead re-exports ────────────────────────────
  let pruneResult = { deletedImages: [], rewrittenAssets: [] };
  if (PRUNE_DEAD_EXPORTS) {
    pruneResult = await pruneDeadExports(texts);
    if (pruneResult.deletedImages.length) {
      const removed = new Set(pruneResult.deletedImages);
      images = images.filter(p => !removed.has(p));
    }
  }

  // ── STEP 2: orphan image scan (basename) ─────────────────────
  // 重新读 corpus（assets.ts 可能已被改写）
  const corpus = (await Promise.all(
    texts.map(t => readFile(t, "utf8").catch(() => ""))
  )).join("\n");

  const used = new Set();
  const unused = [];
  for (const img of images) {
    if (isNeverDelete(img)) { used.add(img); continue; }
    const base = path.basename(img);
    if (corpus.includes(base)) used.add(img);
    else unused.push(img);
  }

  let unusedBytes = 0;
  for (const u of unused) unusedBytes += (await stat(u)).size;
  console.log(`══ STEP 2 未引用图片：${unused.length} 个，合计 ${fmtMB(unusedBytes)} ══`);
  unused.sort().forEach(u => console.log(`  - ${rel(u)}`));
  if (unused.length) console.log("");

  if (DELETE_UNUSED && !DRY_RUN) {
    for (const u of unused) await unlink(u);
    console.log(`[step 2] deleted ${unused.length} orphan images.\n`);
  } else if (DELETE_UNUSED) {
    console.log(`[step 2] dry-run: would delete ${unused.length} orphan images.\n`);
  }

  // ── STEP 3: lossless compression ─────────────────────────────
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
        optimized = await sharp(original, { animated: false })
          .jpeg({ quality: 95, mozjpeg: true })
          .toBuffer();
      }
    } catch (err) {
      console.warn(`[skip] ${rel(img)}: ${err.message}`);
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
  console.log(`══ STEP 3 压缩结果（${DRY_RUN ? "预估" : "实际"}）══`);
  console.log(`  目标图片：${targets.length}`);
  console.log(`  生效优化：${changed}`);
  console.log(`  跳过 JPEG（默认无损模式）：${skippedJpeg}`);
  console.log(`  压缩前：${fmtMB(bBefore)}`);
  console.log(`  压缩后：${fmtMB(bAfter)}`);
  console.log(`  节省：${fmtKB(saved)} (${pct}%)`);
  if (DRY_RUN) console.log(`\n[hint] 加 --apply 执行实际改动；加 --delete-unused 删除孤儿；加 --allow-jpeg-recompress 重压 JPEG`);
}

main().catch(err => { console.error(err); process.exit(1); });
