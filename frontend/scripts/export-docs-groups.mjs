#!/usr/bin/env node
/**
 * 导出指定分组的文档正文为单份 Markdown（便于外部评审 / 交付 / 灌给 LLM）。
 *
 * 数据来源是 `.fumadocs-content/docs/<locale>/` 下 sync 脚本生成的产物：
 *   - `meta.json` 提供分组名与页面顺序（与线上侧边栏完全一致）
 *   - 各 `*.mdx` 的 frontmatter 提供 title / description，正文即页面内容
 * 因此导出结果和用户在文档站看到的内容、顺序一一对应，不会漂移。
 *
 * 用法：
 *   node scripts/export-docs-groups.mjs --locale zh-sg \
 *     --groups "开始使用,套餐与开通,功能与配置" \
 *     --out ../docs-export.md
 *
 * 参数：
 *   --locale  产物目录名：en-us | zh-cn | zh-sg | zh-hant | id-id（默认 zh-sg）
 *   --groups  逗号分隔的分组名，需与 meta.json 中 `---分组名---` 一致
 *   --out     输出文件路径（相对本脚本所在目录解析；默认打印到 stdout）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(here, '..');
const contentRoot = join(frontendRoot, '.fumadocs-content', 'docs');

const GROUP_SEPARATOR = /^---(.+)---$/;

function parseArgs(argv) {
  const args = { locale: 'zh-sg', groups: [], out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--locale' && value) { args.locale = value; i += 1; }
    else if (key === '--groups' && value) { args.groups = value.split(',').map((g) => g.trim()).filter(Boolean); i += 1; }
    else if (key === '--out' && value) { args.out = value; i += 1; }
  }
  return args;
}

/** 从 mdx 中拆出 frontmatter 字段与正文。 */
function splitMdx(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { data: {}, body: text.trim() };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { data: {}, body: text.trim() };

  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    // sync 脚本用 JSON.stringify 写入字符串字段，这里对称地用 JSON.parse 还原，
    // 避免手写反转义漏掉引号 / 换行等边界情况。
    try {
      data[key] = JSON.parse(rawValue);
    } catch {
      data[key] = rawValue;
    }
  }
  return { data, body: text.slice(end + 5).trim() };
}

/**
 * 丢弃正文开头残留的一级标题。
 *
 * sync 脚本的 stripTitle 仅在「md 内 h1」与「注册表 title」完全一致时才剥离，
 * 国际站部分页面二者不同（如 title 为 `Telegram`，md 内为 `配置通道 - Telegram`），
 * 于是 h1 被保留。导出件已用页面 title 作 h2，若不去掉这个残留 h1，
 * 降级后会出现两个连续同级标题。
 */
function dropLeadingHeading(body) {
  const lines = body.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index >= lines.length || !/^#\s+\S/.test(lines[index])) return body;

  lines.splice(index, 1);
  // 顺带吃掉标题后紧跟的空行，避免正文以多余空白开头。
  while (index < lines.length && lines[index].trim() === '') lines.splice(index, 1);
  return lines.join('\n');
}

/**
 * 把正文里的标题整体降一级（h2 → h3 …）。
 * 导出件把「文档标题」作为 h2，正文原有的 h2 若不下沉会和它同级，破坏大纲层次。
 * 代码块内的 `#` 不是标题，需跳过。
 */
function demoteHeadings(body) {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^(#{1,5})\s/, (_m, hashes) => `${hashes}# `);
    })
    .join('\n');
}

/** 按 meta.json 还原「分组 → 页面 slug 列表」。 */
function readGroupedSlugs(localeRoot) {
  const metaPath = join(localeRoot, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(`missing meta.json: ${metaPath}（先跑 node scripts/sync-fumadocs-content.mjs）`);
  }
  const grouped = new Map();
  let current = null;
  for (const entry of JSON.parse(readFileSync(metaPath, 'utf8')).pages ?? []) {
    const separator = entry.match(GROUP_SEPARATOR);
    if (separator) {
      current = separator[1];
      if (!grouped.has(current)) grouped.set(current, []);
      continue;
    }
    if (current) grouped.get(current).push(entry);
  }
  return grouped;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.groups.length === 0) {
    console.error('用法：node scripts/export-docs-groups.mjs --locale zh-sg --groups "开始使用,套餐与开通" [--out path.md]');
    process.exit(1);
  }

  const localeRoot = join(contentRoot, args.locale);
  const grouped = readGroupedSlugs(localeRoot);

  const missingGroups = args.groups.filter((g) => !grouped.has(g));
  if (missingGroups.length > 0) {
    console.error(`未找到分组：${missingGroups.join('、')}`);
    console.error(`该 locale 可用分组：${[...grouped.keys()].join('、')}`);
    process.exit(1);
  }

  const chunks = [];
  const toc = [];
  let pageCount = 0;

  for (const group of args.groups) {
    const slugs = grouped.get(group);
    chunks.push(`# ${group}\n`);
    toc.push(`- **${group}**`);

    for (const slug of slugs) {
      const mdxPath = join(localeRoot, `${slug}.mdx`);
      if (!existsSync(mdxPath)) {
        console.error(`跳过（产物缺失）：${mdxPath}`);
        continue;
      }
      const { data, body } = splitMdx(readFileSync(mdxPath, 'utf8'));
      const title = data.title ?? slug;
      pageCount += 1;
      toc.push(`  - ${title} — \`/docs/${slug}\``);

      chunks.push(`## ${title}\n`);
      chunks.push(`> 页面路径：\`/docs/${slug}\``);
      if (data.description) chunks.push(`>\n> 页面描述：${data.description}`);
      chunks.push('');
      chunks.push(demoteHeadings(dropLeadingHeading(body)));
      chunks.push('\n---\n');
    }
  }

  const header = [
    '# LightVela 文档导出',
    '',
    `- 语言：\`${args.locale}\``,
    `- 导出分类：${args.groups.join('、')}`,
    `- 页面数：${pageCount}`,
    `- 导出时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    '',
    '> 本文件由 `frontend/scripts/export-docs-groups.mjs` 从文档站产物自动生成，',
    '> 分组与页面顺序与线上侧边栏一致。请勿手工编辑：正文改动应回到',
    '> `frontend/src/content/docs/` 下的源 Markdown。',
    '',
    '## 目录',
    '',
    ...toc,
    '',
    '---',
    '',
  ].join('\n');

  const output = `${header}${chunks.join('\n')}`;

  if (!args.out) {
    process.stdout.write(output);
    return;
  }
  const outPath = isAbsolute(args.out) ? args.out : resolve(here, args.out);
  writeFileSync(outPath, output);
  console.log(`已导出 ${pageCount} 篇（${args.groups.join('、')}）→ ${outPath}`);
}

main();
