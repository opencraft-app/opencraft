import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 文档「内容最后更新日期」的单一事实来源。
 *
 * ── 为什么是显式清单，而不是构建期读 git ───────────────────────
 * 关键区分（我第一版把这两件事混为一谈，一起否决了，是错的）：
 *
 * **构建期跑 git 不可行**，因为 CI 用 `fetchDepth: 50` 浅克隆
 * （`.ci/frontend.yml`）。浅克隆里 `git log` 对早于 shallow boundary 的文件
 * 会返回 boundary 提交时间；mono2 提交很密，50 个提交往往只覆盖几天 ——
 * 几乎每篇文档都会拿到「接近本次构建」的日期，等于换一种方式重现
 * 「每天构建就每天变」，而且更难发现。
 *
 * **本地一次性生成初始值则完全可行**，见 `--from-git`。本地是完整克隆，
 * 没有 boundary 问题。加上 `--no-merges` 后，实测 204 篇里 180 篇
 * 三种口径（`%cI` 简化 / `%aI` 简化 / `%aI` 全历史）完全一致，
 * 其余 24 篇仅差 1 天。我第一版测出的 `plans.md` 差 11 天，
 * 根因是 merge 提交污染，`--no-merges` 即可消除 —— 当时没试这个组合。
 *
 * 所以最终形态：
 *   - **清单是真源**，进版本控制，构建期只读它、绝不跑 git；
 *   - 初始值与批量修正用 `--from-git` 在本地生成，人工可覆盖；
 *   - 构建链只允许 `--check`（纯文件系统校验，浅克隆下同样可靠）。
 *
 * ── 为什么不写进源 md 的 frontmatter ────────────────────────
 * `src/content/docs/*.md` 是**纯 markdown、没有 frontmatter**（首行即 `# 标题`），
 * frontmatter 由 `sync-fumadocs-content.mjs` 生成。给源文件加 frontmatter 会被
 * `stripTitle()` / 正文处理当作正文，破坏产物。
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const repoRoot = resolve(frontendRoot, '..');

export const MANIFEST_PATH = join(frontendRoot, 'src/content/docs/last-updated.json');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 磁盘上现存的全部文档源文件（相对 frontend 的路径，与 frontmatter 的 `source_path` 同格式）。
 * 清单必须与这份列表**一一对应**：缺条目页面就没日期，多条目就是幽灵。
 */
export function listDocSourceFiles({ root = frontendRoot } = {}) {
  const docsRoot = join(root, 'src/content/docs');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith('.md')) files.push(relative(root, path));
    }
  };
  walk(docsRoot);
  return files.sort();
}

/**
 * 工作区里有未提交改动的文档。
 *
 * 这个信号与 git 历史无关，因此**完全可靠** —— 用来提醒「你改了内容，
 * 记得把日期也改了」，是唯一值得自动化的一环。
 */
export function locallyModifiedDocs() {
  let output;
  try {
    output = execFileSync('git', ['status', '--porcelain', '--', 'frontend/src/content/docs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // 不在 git 仓库里（例如从 artifact 解包后构建）：不做提醒，也不报错
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'))
    .map((line) => line.replace(/^\S+\s+/, '').replace(/^"|"$/g, ''))
    .map((path) => relative('frontend', path))
    .filter((path) => !path.startsWith('..'))
    .sort();
}

export function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return {};
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[docs-last-updated] manifest must be a JSON object: ${manifestPath}`);
  }
  return parsed;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * 仓库是否为浅克隆。
 *
 * 浅克隆下 `git log` 对早于 shallow boundary 的文件返回 boundary 提交时间，
 * 拿到的日期毫无意义。CI 用 `fetchDepth: 50`，所以 `--from-git` 必须拒绝执行，
 * 而不是静默产出一堆「接近构建日」的假日期。
 */
export function isShallowRepository() {
  try {
    return git(['rev-parse', '--is-shallow-repository']) === 'true';
  } catch {
    return false;
  }
}

/**
 * 从 git 历史取某文件的最后**实质**修改日期。
 *
 * `--no-merges` 是关键：merge 提交会把「合并操作时间」算作文件修改时间，
 * 这正是第一版实现里 `plans.md` 出现 11 天分歧的原因（`git log -1` 得 08-07、
 * `--full-history -1` 得 08-18）。加上 `--no-merges` 后两者一致。
 *
 * 用 `%aI`（author date）而非 `%cI`（committer date）：后者会被 rebase 重写成
 * 操作时间，而 author date 记录的是内容真正被写下的时刻。
 *
 * @returns YYYY-MM-DD，或 undefined（文件未进版本库，例如刚新建）
 */
export function gitLastModifiedDate(sourcePathRelativeToFrontend) {
  const repoPath = join('frontend', sourcePathRelativeToFrontend);
  let output;
  try {
    output = git(['log', '--no-merges', '-1', '--format=%aI', '--', repoPath]);
  } catch {
    return undefined;
  }
  if (!output) return undefined;
  return output.slice(0, 10);
}

/**
 * 文件进入版本库的日期（最早一次提交）。
 * 用于校验：内容更新日期不可能早于文件诞生日期。
 */
export function gitFirstCommitDate(sourcePathRelativeToFrontend) {
  const repoPath = join('frontend', sourcePathRelativeToFrontend);
  try {
    const output = git(['log', '--no-merges', '--follow', '--format=%aI', '--', repoPath]);
    if (!output) return undefined;
    const lines = output.split('\n').filter(Boolean);
    return lines[lines.length - 1]?.slice(0, 10);
  } catch {
    return undefined;
  }
}

export function assertValidDate(sourcePath, date, today = new Date().toISOString().slice(0, 10)) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw new Error(`[docs-last-updated] invalid date for ${sourcePath}: ${date} (expected YYYY-MM-DD)`);
  }
  if (date > today) {
    // 未来日期会让搜索引擎与 AI 引擎拿到假的新鲜度信号
    throw new Error(`[docs-last-updated] future date for ${sourcePath}: ${date} > ${today}`);
  }
  return date;
}

export function writeManifest(entries, manifestPath = MANIFEST_PATH) {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  return sorted;
}

/**
 * 补齐 / 清理清单。**不修改任何已有日期** —— 日期是人写的，脚本无权改。
 *
 * - 磁盘上新增的文档 → 补一条，日期取 `today`（它确实是今天才有的内容）；
 * - 清单里已不存在的文档 → 删掉。
 */
export function syncManifest({
  manifestPath = MANIFEST_PATH,
  files = listDocSourceFiles(),
  today = new Date().toISOString().slice(0, 10),
  log = console.log,
} = {}) {
  const existing = loadManifest(manifestPath);
  const merged = {};
  const added = [];

  for (const path of files) {
    const current = existing[path];
    if (current === undefined) {
      merged[path] = assertValidDate(path, today, today);
      added.push(path);
    } else {
      merged[path] = assertValidDate(path, current, today);
    }
  }

  const removed = Object.keys(existing).filter((path) => !(path in merged));
  writeManifest(merged, manifestPath);

  log(
    `[docs-last-updated] manifest synced: ${added.length} added, ${removed.length} removed, ` +
      `${Object.keys(merged).length} total`,
  );
  for (const path of added) log(`  + ${path} → ${today}`);
  for (const path of removed) log(`  - ${path}`);

  const modified = locallyModifiedDocs().filter((path) => !added.includes(path));
  if (modified.length > 0) {
    log(
      `\n[docs-last-updated] ⚠️ ${modified.length} doc(s) have uncommitted edits. ` +
        'If the content actually changed, update their dates by hand:',
    );
    for (const path of modified) log(`  ~ ${path} (currently ${merged[path]})`);
  }

  return { added, removed, modified, total: Object.keys(merged).length };
}

/**
 * 用 git 历史重建清单日期。**仅供本地执行，禁止进构建链**（浅克隆下结果无意义）。
 *
 * 语义：每篇文档取其最后一次实质提交的 author date。
 * 已在工作区改动但未提交的文档取 `today` —— 它们的内容确实是今天变的，
 * git 里还查不到。
 *
 * ⚠️ **必须在 merge 提交完成后再跑，不要在 merge 冲突未解决时跑。**
 * merge 进行中时，对方分支带来的新文件在 index 里是 `A`（尚未进 HEAD），
 * `git log -- <path>` 查不到任何提交，会全部 fallback 到 `today`；
 * 被 merge 改动的既有文件也只能查到本侧的旧日期。
 * 实测合并 master 的 6 篇文档改动时，merge 未提交跑出「6 as today」，
 * 提交后重跑才得到「208 from history, 0 as today」。
 * 输出里的 `N as today` 就是这个问题的信号 —— 数字不为 0 时先确认是否真有未提交改动。
 *
 * @param touched 视为「本次已改动」的文档清单（相对 frontend）。
 *                默认从 `git status` 取未提交改动；批量修正历史批次时可显式传入。
 */
export function manifestFromGit({
  manifestPath = MANIFEST_PATH,
  files = listDocSourceFiles(),
  touched = locallyModifiedDocs(),
  today = new Date().toISOString().slice(0, 10),
  isShallow = isShallowRepository,
  gitLastModified = gitLastModifiedDate,
  log = console.log,
} = {}) {
  if (isShallow()) {
    throw new Error(
      '[docs-last-updated] refusing to run --from-git in a shallow clone: ' +
        'git log would return the shallow boundary date for most files. ' +
        'Run `git fetch --unshallow` first, or edit the manifest by hand.',
    );
  }

  const touchedSet = new Set(touched);
  const result = {};
  const stats = { fromGit: 0, fromToday: 0, missing: [] };

  for (const path of files) {
    if (touchedSet.has(path)) {
      result[path] = today;
      stats.fromToday += 1;
      continue;
    }
    const date = gitLastModified(path);
    if (date === undefined) {
      // 文件不在版本库里（刚新建且未 git add）：只能按今天算
      result[path] = today;
      stats.fromToday += 1;
      stats.missing.push(path);
      continue;
    }
    result[path] = assertValidDate(path, date, today);
    stats.fromGit += 1;
  }

  writeManifest(result, manifestPath);

  const distribution = {};
  for (const date of Object.values(result)) distribution[date] = (distribution[date] ?? 0) + 1;

  log(
    `[docs-last-updated] rebuilt ${Object.keys(result).length} entries from git ` +
      `(${stats.fromGit} from history, ${stats.fromToday} as today)`,
  );
  for (const [date, count] of Object.entries(distribution).sort()) {
    log(`  ${date}: ${count}`);
  }
  if (stats.missing.length > 0) {
    log(`  ⚠️ ${stats.missing.length} file(s) not in git yet, dated ${today}`);
  }

  return { ...stats, distribution, total: Object.keys(result).length };
}

/**
 * 校验清单。**默认不依赖 git 历史**，因此在浅克隆的 CI 上同样可靠。
 *
 * `checkBirthDates` 会额外校验「更新日期不早于文件诞生日期」，
 * 它需要完整 git 历史且每篇跑一次 `git log`（204 篇约 10 秒），
 * 故仅在本地按需开启（`--check --strict`），不进构建链。
 *
 * @param gitFirstCommit 注入点，便于测试替换掉真实 git 调用
 */
export function checkManifest({
  manifestPath = MANIFEST_PATH,
  checkBirthDates = false,
  isShallow = isShallowRepository,
  gitFirstCommit = gitFirstCommitDate,
  log = console.log,
} = {}) {
  const manifest = loadManifest(manifestPath);
  const today = new Date().toISOString().slice(0, 10);
  const problems = [];

  for (const [path, date] of Object.entries(manifest)) {
    try {
      assertValidDate(path, date, today);
    } catch (error) {
      problems.push(error.message.replace('[docs-last-updated] ', ''));
    }
  }

  const onDisk = listDocSourceFiles();
  const onDiskSet = new Set(onDisk);
  for (const path of onDisk) {
    if (manifest[path] === undefined) problems.push(`${path}: on disk but missing from manifest`);
  }
  for (const path of Object.keys(manifest)) {
    if (!onDiskSet.has(path)) problems.push(`${path}: in manifest but not on disk`);
  }

  if (checkBirthDates && !isShallow()) {
    // 内容更新日期不可能早于文件进入版本库的日期。
    // 这条能抓出手写错（打错年月、复制粘贴串行）——纯文件系统校验抓不到。
    for (const [path, date] of Object.entries(manifest)) {
      if (!onDiskSet.has(path)) continue;
      const born = gitFirstCommit(path);
      if (born && date < born) {
        problems.push(`${path}: date ${date} predates first commit ${born}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[docs-last-updated] manifest is out of date (${problems.length} problem(s)). ` +
        `Run \`node scripts/docs-last-updated.mjs --sync\`:\n  ${problems.join('\n  ')}`,
    );
  }

  log(
    `[docs-last-updated] manifest check passed for ${Object.keys(manifest).length} doc(s)` +
      (checkBirthDates ? ' (including birth-date validation)' : ''),
  );
  return { checked: Object.keys(manifest).length, problems: [] };
}

/**
 * 构建期使用：只读清单，绝不跑 git。
 *
 * @returns YYYY-MM-DD，或 undefined（清单里没登记 → 调用方决定回退策略）
 */
export function createLastUpdatedResolver({ manifestPath = MANIFEST_PATH } = {}) {
  const manifest = loadManifest(manifestPath);
  const today = new Date().toISOString().slice(0, 10);
  return function resolveLastUpdated(sourcePathRelativeToFrontend) {
    const value = manifest[sourcePathRelativeToFrontend];
    if (value === undefined) return undefined;
    return assertValidDate(sourcePathRelativeToFrontend, value, today);
  };
}

/**
 * 把清单里指定的一批文档设为同一日期。
 * 用于「这批内容今天统一复核过」的场景（本次 GEO 治理即如此）。
 */
export function setDates({ paths, date, manifestPath = MANIFEST_PATH, log = console.log } = {}) {
  const manifest = loadManifest(manifestPath);
  const today = new Date().toISOString().slice(0, 10);
  assertValidDate('(bulk)', date, today);

  let changed = 0;
  for (const path of paths) {
    if (manifest[path] === undefined) {
      throw new Error(`[docs-last-updated] not in manifest: ${path}`);
    }
    if (manifest[path] !== date) {
      manifest[path] = date;
      changed += 1;
    }
  }
  writeManifest(manifest, manifestPath);
  log(`[docs-last-updated] set ${changed} doc(s) to ${date}`);
  return { changed };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--sync')) {
    syncManifest();
    return;
  }
  if (argv.includes('--check')) {
    // --strict 额外校验「更新日期不早于文件诞生日期」，需完整 git 历史。
    // 构建链只用裸 --check，见 scripts/docs-last-updated.test.ts 的断言。
    checkManifest({ checkBirthDates: argv.includes('--strict') });
    return;
  }
  if (argv.includes('--from-git')) {
    manifestFromGit();
    return;
  }
  const setIndex = argv.indexOf('--set-all');
  if (setIndex !== -1) {
    const date = argv[setIndex + 1];
    if (!date) throw new Error('[docs-last-updated] --set-all requires a YYYY-MM-DD argument');
    setDates({ paths: listDocSourceFiles(), date });
    return;
  }
  throw new Error(
    '[docs-last-updated] usage: docs-last-updated.mjs\n' +
      '  --check [--strict]   校验清单（构建链只用裸 --check；--strict 额外校验诞生日期，需完整 git 历史）\n' +
      '  --sync               补齐新增 / 清理幽灵条目，不改已有日期\n' +
      '  --from-git           用 git 历史重建全部日期（仅本地，禁止进构建链）\n' +
      '  --set-all YYYY-MM-DD 全部设为同一日期',
  );
}

const currentModulePath = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] && resolve(process.argv[1]) === currentModulePath;

if (isMainModule) {
  main();
}
