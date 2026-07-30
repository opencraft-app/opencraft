import { siteUrl } from '@next-site/seo';
import { isGlobal } from '@/lib/region';

export const dynamic = 'force-static';

type RobotsGroup = {
  /** 该组的注释行（不含首个 '#'，渲染时原样输出；可省略） */
  comment?: string;
  /** 共享同一条 Allow 规则的 User-agent 列表 */
  userAgents: string[];
};

/**
 * 国际站：显式放开主流 AI 搜索 / 传统搜索爬虫，每个 UA 单独一段。
 */
const GLOBAL_GROUPS: RobotsGroup[] = [
  { userAgents: ['OAI-SearchBot'] },
  { userAgents: ['PerplexityBot'] },
  { userAgents: ['Claude-SearchBot'] },
  { userAgents: ['Claude-User'] },
  { userAgents: ['Googlebot'] },
  { userAgents: ['bingbot'] },
  { userAgents: ['Applebot'] },
  { userAgents: ['Amzn-SearchBot'] },
  { userAgents: ['Amzn-User'] },
  { userAgents: ['*'] },
];

/**
 * 国内站：按厂商分组放开国内主流 AI / 搜索爬虫，并兼顾少量海外爬虫。
 */
const CN_GROUPS: RobotsGroup[] = [
  {
    comment: '# Baidu / 文心 / 百度搜索',
    userAgents: ['Baiduspider', 'BaiduAI', 'Baidu-YiYan', 'ERNIEBot', 'ERNIE-Bot'],
  },
  { comment: '# ByteDance / 豆包', userAgents: ['Bytespider'] },
  {
    comment: '# Moonshot / Kimi',
    userAgents: ['KimiBot', 'MoonshotBot', 'MoonshotAI', 'Kimi-User'],
  },
  {
    comment: '# Alibaba / 通义千问 / 阿里云',
    userAgents: ['Qwen', 'QwenBot', 'TongyiBot', 'AliyunBot', 'AliyunCrawler', 'AlibabaCloud'],
  },
  { comment: '# Tencent / 混元相关可能入口', userAgents: ['TencentBot', 'TencentTraveler'] },
  { comment: '# Zhipu / 智谱', userAgents: ['ZhipuBot'] },
  { comment: '# MiniMax', userAgents: ['MiniMaxBot'] },
  {
    comment: '# Sogou / 360 / Shenma',
    userAgents: ['Sogou', 'Sogou spider', '360Spider', 'HaosouSpider', 'YisouSpider'],
  },
  { comment: '# OpenAI / ChatGPT Search', userAgents: ['OAI-SearchBot', 'ChatGPT-User'] },
  { comment: '# Microsoft / Bing / Copilot', userAgents: ['bingbot', 'BingPreview'] },
  { comment: '# Google, mainly for overseas access to the Chinese site', userAgents: ['Googlebot'] },
  { comment: '# Default rule', userAgents: ['*'] },
];

function renderRobots(header: string[], groups: RobotsGroup[]): string {
  const lines: string[] = [...header];

  for (const group of groups) {
    if (group.comment) lines.push(group.comment);
    for (const ua of group.userAgents) lines.push(`User-agent: ${ua}`);
    lines.push('Allow: /', '');
  }

  lines.push(`Sitemap: ${siteUrl()}/sitemap.xml`, '');

  return lines.join('\n');
}

export function GET() {
  const body = isGlobal
    ? renderRobots([], GLOBAL_GROUPS)
    : renderRobots(['# LightVela China site robots.txt', `# ${siteUrl()}`, ''], CN_GROUPS);

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
