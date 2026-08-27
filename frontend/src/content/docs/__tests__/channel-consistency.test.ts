import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 渠道口径一致性契约测试。
 *
 * 背景：渠道清单是最容易悄悄漂移的一类事实 —— 产品加一个通道，
 * 代码改了，但散落在 200+ 篇文档、`llms.txt`、侧边栏里的清单不会跟着变。
 * 这类漂移对 GEO 是直接伤害：AI 引擎会引用旧清单，低报或错报产品能力。
 *
 * 真实发生过两次：
 *   1. `04-core-concepts.md` 写「支持三个通道」且表格漏了企业微信，
 *      而 `01-overview.md` 写四个 —— 两页互相矛盾；
 *   2. master 提交 `35575bd19` 加入钉钉与 Slack 后，国内站实际 5 个通道，
 *      但全站文案仍写 4 个，且「只有 QQ 需要手工填参数」也不再成立（钉钉同样要填）。
 *
 * 因此这里锁定的是「不允许出现旧清单」，而不是逐篇断言措辞 ——
 * 后者会让每次文案微调都要改测试。
 */

const frontendRoot = join(import.meta.dirname, '../../../..');

/** 国内站 5 个渠道（真源：`agent-channel-panel.tsx` 的 HERMES_CHANNEL_LIST）。 */
const CN_CHANNELS = ['微信', 'QQ', '企业微信', '飞书', '钉钉'] as const;

/** 国际站 8 个渠道。 */
const GLOBAL_CHANNELS = [
  'Telegram',
  'WhatsApp',
  'Discord',
  'Slack',
  'WeChat',
  'QQ',
  'WeCom',
  'Lark',
] as const;

/**
 * 已过期的渠道表述。出现即说明有位置没跟上产品变更。
 *
 * 注意分隔符有三种写法（、/ 空格斜杠/ 紧凑斜杠），历史上就是因为只替换了
 * 其中一种而漏改，所以三种都要覆盖。
 */
const STALE_CN_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /微信、QQ、企业微信、飞书(?!、钉钉)/, why: '国内站渠道清单缺钉钉' },
  { pattern: /微信 \/ QQ \/ 企业微信 \/ 飞书(?! \/ 钉钉)/, why: '国内站渠道清单缺钉钉（斜杠写法）' },
  { pattern: /微信\/QQ\/企业微信\/飞书(?!\/钉钉)/, why: '国内站渠道清单缺钉钉（紧凑斜杠写法）' },
  { pattern: /国内站.{0,6}(?:当前)?支持(?:四|4)个通道/, why: '国内站通道数已是 5 个' },
  { pattern: /国内站(?:四|4)个可用通道/, why: '国内站通道数已是 5 个' },
  // 钉钉同样支持「填写 Client ID / Secret」，QQ 不再是唯一需要填参数的通道
  { pattern: /只有 QQ 需要手工填/, why: '钉钉同样支持填写应用凭证，QQ 不再是唯一' },
  { pattern: /QQ 是(?:四|5|五)?个?通道中唯一需要手工填/, why: '同上' },
  { pattern: /国内站.{0,10}(?:面向|支持)微信、飞书、QQ/, why: '国内站渠道清单过期（缺企业微信与钉钉）' },
  { pattern: /(?:China region|region Tiongkok).{0,20}(?:targets|menyasar) WeChat, Lark, and QQ/i, why: '同上（英文/印尼语版本）' },
];

function readDoc(relativePath: string): string {
  return readFileSync(join(frontendRoot, relativePath), 'utf8');
}

/**
 * 递归列出全部文档源文件（相对 frontend）。
 *
 * 刻意不复用 `scripts/docs-last-updated.mjs` 的 `listDocSourceFiles`：
 * `tsconfig.app.json` 未开 `allowJs`，从 `src/` 下 import `.mjs` 会报 TS7016；
 * 且测试自带遍历才能发现被测实现漏扫目录之类的问题。
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

const allDocs = listDocs();

describe('渠道口径一致性', () => {
  it('全部文档都不含已过期的渠道表述', async () => {
    const offenders: string[] = [];

    for (const path of allDocs) {
      const markdown = readDoc(path);
      for (const { pattern, why } of STALE_CN_PATTERNS) {
        if (pattern.test(markdown)) offenders.push(`${path}: ${why}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('国内站核心页列全 5 个渠道', async () => {
    // 只挑「必然要列全清单」的页面，避免把举例式表述也纳入约束
    const mustListAll = [
      'src/content/docs/01-overview.md',
      'src/content/docs/04-core-concepts.md',
      'src/content/docs/07-faq.md',
    ];
    const offenders: string[] = [];

    for (const path of mustListAll) {
      const markdown = readDoc(path);
      const missing = CN_CHANNELS.filter((channel) => !markdown.includes(channel));
      if (missing.length > 0) offenders.push(`${path}: 缺 ${missing.join('、')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('llms.txt 的「支持渠道」与两站清单完全一致（AI 引擎首要引用来源）', async () => {
    const route = readDoc('src/app/llms.txt/route.next.ts');

    const cnFact = /\{ label: '支持渠道', value: '([^']+)' \}/.exec(route)?.[1];
    expect(cnFact).toBe('微信、QQ、企业微信、飞书、钉钉（国内站）');

    const globalFact = /label: 'Supported channels',\s*\n\s*value: '([^']+)'/.exec(route)?.[1];
    expect(globalFact).toBe('Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark');
    for (const channel of GLOBAL_CHANNELS) {
      expect(globalFact).toContain(channel);
    }
  });

  it('04-core-concepts 通道表包含钉钉，但不链到尚不存在的文档', async () => {
    const markdown = readDoc('src/content/docs/04-core-concepts.md');

    expect(markdown).toMatch(/\|\s*钉钉\s*\|/);
    // channel-dingtalk.md 尚未创建（见 geo-fact-table.md 的 C8 / Q11），
    // 提前加链接会造成文档内死链
    expect(markdown).not.toContain('channel-dingtalk');
  });

  it('钉钉文档一旦创建，就必须同时注册进侧边栏（防止只建文件、没入口）', async () => {
    const docExists = allDocs.includes('src/content/docs/configuration/channel-dingtalk.md');
    const sidebar = readDoc('src/config/docs-sidebar.ts');
    const registered = sidebar.includes('configuration/channel-dingtalk');

    // 两者必须同时存在或同时不存在
    expect(registered).toBe(docExists);
  });
});
