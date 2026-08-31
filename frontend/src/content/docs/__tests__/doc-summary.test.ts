import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 文档「摘要」段契约测试。
 *
 * 为什么需要：GEO（生成引擎优化）的核心是让 AI 检索引擎能**直接引用**一段
 * 自包含的答案。若文档开头是「本页覆盖 / 引子」这类过渡内容，引擎只能自己
 * 从正文里拼凑，容易拼错或转而引用第三方描述。
 *
 * 约定（按现存文档的真实写法归纳，而不是照搬某一篇的样式）：
 *   1. 摘要必须是文档里**第一个二级标题** —— 允许它前面有 H1、配图、一段引子，
 *      但不能被别的章节挤到后面；
 *   2. 摘要段是**连续散文**，不能是列表或表格（引擎会把它们切碎）；
 *   3. 摘要段内**含加粗结论**。既有文档有两种风格：整段加粗（Hermes Agent 解读系列）
 *      与「加粗结论句 + 普通补充句」（对比 / 场景系列）。两者都能被引擎正确摘取，
 *      故只要求含加粗，不强制整段；
 *   4. 长度自包含但不冗长；
 *   5. 有摘要段的文档必须在 `sync-fumadocs-content.mjs` 里标记
 *      `hideDescription: true`，否则页面顶部会同时渲染 description 段和摘要段。
 */

const frontendRoot = join(import.meta.dirname, '../../../..');
const SUMMARY_HEADINGS = ['摘要', 'Summary', 'Ringkasan', 'Resumen', '概要'];
const SUMMARY_PATTERN = new RegExp(`^##\\s+(${SUMMARY_HEADINGS.join('|')})\\s*$`, 'm');

function readDoc(relativePath: string): string {
  return readFileSync(join(frontendRoot, relativePath), 'utf8');
}

/** 摘要区块：从摘要标题到下一个二级标题或分隔线为止。 */
function summaryBlock(markdown: string): string | null {
  const match = SUMMARY_PATTERN.exec(markdown);
  if (!match) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const end = rest.search(/\n\s*(?:##\s|---\s*$)/m);
  const block = (end === -1 ? rest : rest.slice(0, end)).trim();
  return block.length > 0 ? block : null;
}

/** 摘要区块的第一段（用于判断是否以加粗结论开场）。 */
function summaryLead(markdown: string): string | null {
  const block = summaryBlock(markdown);
  if (!block) return null;
  return block.split(/\n\s*\n/, 1)[0]?.trim() ?? null;
}

/**
 * 拉丁字母语言用字符数衡量长度天然偏大（同样信息量约为中文的 1.6–2 倍），
 * 因此按语言分档，而不是一刀切。
 */
function isLatinLocale(path: string): boolean {
  return path.startsWith('src/content/docs/en/') ||
    path.startsWith('src/content/docs/id/') ||
    path.startsWith('src/content/docs/es/');
}

/**
 * 递归列出全部文档源文件（相对 frontend）。
 *
 * 刻意不复用 `scripts/docs-last-updated.mjs` 的 `listDocSourceFiles`：
 * 一是 `tsconfig.app.json` 未开 `allowJs`，从 `src/` 下 import `.mjs` 会报 TS7016；
 * 二是测试自带遍历才能发现被测实现漏扫目录之类的问题 —— 复用会一起错。
 */
function listDocs(dir = join(frontendRoot, 'src/content/docs')): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return listDocs(full);
      return entry.name.endsWith('.md') ? [relative(frontendRoot, full)] : [];
    })
    .sort();
}

const docsWithSummary = listDocs().filter((path) => SUMMARY_PATTERN.test(readDoc(path)));

describe('文档摘要段（GEO 可引用答案）', () => {
  it('全部文档都有摘要段', async () => {
    const missing = listDocs().filter((path) => !SUMMARY_PATTERN.test(readDoc(path)));

    // 摘要是 GEO 的基础设施：缺一篇就意味着该页没有可直接引用的答案。
    expect(missing).toEqual([]);
  });

  it('摘要是文档里第一个二级标题，不能被别的章节挤到后面', async () => {
    const offenders: string[] = [];

    for (const path of docsWithSummary) {
      const markdown = readDoc(path);
      const firstHeading = /^##\s+(.+)$/m.exec(markdown)?.[1]?.trim();
      if (!firstHeading) {
        offenders.push(`${path}: 找不到二级标题`);
        continue;
      }
      if (!SUMMARY_HEADINGS.includes(firstHeading)) {
        offenders.push(`${path}: 第一个二级标题是「${firstHeading}」，不是摘要`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('摘要以加粗结论开场（引擎优先摘取的就是这一句）', async () => {
    const offenders: string[] = [];

    for (const path of docsWithSummary) {
      const lead = summaryLead(readDoc(path));
      if (!lead) {
        offenders.push(`${path}: 摘要段为空`);
        continue;
      }
      if (!lead.includes('**')) {
        offenders.push(`${path}: 摘要开场缺少加粗结论`);
      }
      // 开场必须是散文，不能直接甩列表/表格 —— 那样引擎抓到的是碎句。
      // 注意不能用 /^\s*[-*|]/：会把整段加粗的 `**...` 误判成列表项。
      if (/^\s*(?:[-+]\s|\*\s|\|)/.test(lead)) {
        offenders.push(`${path}: 摘要开场是列表或表格`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('整段加粗的摘要内部不再嵌套加粗（否则 markdown 渲染会错乱）', async () => {
    const offenders: string[] = [];

    for (const path of docsWithSummary) {
      const lead = summaryLead(readDoc(path)) ?? '';
      // 只检查「整段加粗」这种写法：`**...**` 内部再出现 `**` 会让
      // markdown 提前闭合，后半段变成普通文本甚至吞掉星号。
      if (!lead.startsWith('**') || !lead.endsWith('**')) continue;
      const inner = lead.slice(2, -2);
      if (inner.includes('**')) {
        offenders.push(`${path}: 整段加粗内部还有 ** 嵌套`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('摘要长度自包含又不冗长（按语言分档）', async () => {
    const offenders: string[] = [];

    for (const path of docsWithSummary) {
      const text = (summaryBlock(readDoc(path)) ?? '').replaceAll('**', '').trim();
      // 拉丁字母语言同信息量的字符数约为中文的 1.6–2 倍，故上限放宽
      const max = isLatinLocale(path) ? 2400 : 1400;
      if (text.length < 60) offenders.push(`${path}: 摘要仅 ${text.length} 字，过短`);
      if (text.length > max) offenders.push(`${path}: 摘要 ${text.length} 字，超过 ${max}`);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * 判定依据是**生成产物的 frontmatter**，而不是去解析 `sync-fumadocs-content.mjs`。
   * 原因：清单有单行与多行两种写法，正则解析必然误判（实测把
   * `globalDocs` 的多行条目全判成缺标记）；而产物里 `description` 与
   * `hide_description` 都是最终值，正是页面实际渲染的依据。
   */
  it('description 非空且正文有摘要时必须 hide_description，避免两段近似内容', async () => {
    const contentRoot = join(frontendRoot, '.fumadocs-content/docs');
    if (!existsSync(contentRoot)) {
      throw new Error(
        '缺少 .fumadocs-content/docs 产物，请先执行 `node scripts/sync-fumadocs-content.mjs`',
      );
    }

    const offenders: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.mdx') ? [full] : [];
      });

    for (const file of walk(contentRoot)) {
      const raw = readFileSync(file, 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
      const body = raw.slice(raw.indexOf('\n---', 4) + 4);
      if (!SUMMARY_PATTERN.test(body)) continue;

      const description = /^description:\s*(.*)$/m.exec(frontmatter)?.[1]?.trim() ?? '';
      const hasDescription = description !== '' && description !== "''" && description !== '""';
      const hidden = /^hide_description:\s*true\s*$/m.test(frontmatter);

      if (hasDescription && !hidden) {
        offenders.push(file.slice(contentRoot.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });
});
