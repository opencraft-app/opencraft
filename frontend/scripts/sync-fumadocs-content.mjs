import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as OpenCC from 'opencc-js';

/**
 * 繁體中文（zh-Hant）文檔转换。
 *
 * 与 UI 文案链路（`scripts/i18n-zh-hant.mjs` + `src/lib/zh-hant.ts` +
 * `src/lib/zh-hant-overrides.ts`）**必须完全一致**：
 *   1. OpenCC `cn → hk`（香港繁体字形，仅字形层简→繁，不做台湾词汇替换。
 *      因此保留港式用词，如「軟件 / 網絡 / 視頻 / 智能 / 信息」，
 *      而非台湾的「軟體 / 網路 / 影片 / 智慧 / 資訊」。）
 *   2. 叠加 ZH_HANT_TERM_OVERRIDES（与 `zh-hant-overrides.ts` 的 TERM_OVERRIDES 同步）。
 *
 * ⚠️ 若此处术语表增删条目，请同步 `src/lib/zh-hant-overrides.ts`（.mjs 不能 import .ts，
 *    只能手动保持一致），否则同一 `/zh-hant/` 语言下用户在 docs 与 UI 中看到的用词会漂移。
 *
 * 只转换中文字符，英文 / 代码 / URL（ASCII）与占位符原样保留。
 */
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'hk' });
const ZH_HANT_TERM_OVERRIDES = {
  // 港澳日常几乎都写「群」而非港标本字「羣」（微信、报刊、社交媒体一致）
  羣: '群',
};

/**
 * 语言代码常量（单一来源，避免文件内 'zh-CN' / 'en-US' / 'zh-Hant' / 'zh-SG' 魔法字符串散落）。
 *
 * ⚠️ `.mjs` 无法 import `src/lib/public-site-routing.ts` 的 `PUBLIC_SITE_LOCALES`，
 * 只能在此手动维护同名镜像。如需增删语言，请同步这两个文件。
 */
const LOCALES = Object.freeze({
  EN_US: 'en-US',
  ZH_CN: 'zh-CN',
  ZH_SG: 'zh-SG',
  ZH_HANT: 'zh-Hant',
});

/** URL 前缀（对应 fumadocs 输出目录），与 `PUBLIC_URL_LANGS` 保持一致。 */
const URL_LANGS = Object.freeze({
  EN_US: 'en-us',
  ZH_CN: 'zh-cn',
  ZH_SG: 'zh-sg',
  ZH_HANT: 'zh-hant',
});

function convertTraditional(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = toTraditional(text);
  for (const [from, to] of Object.entries(ZH_HANT_TERM_OVERRIDES)) {
    if (from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(here, '..');
const sourceRoot = join(frontendRoot, 'src', 'content', 'docs');
const outputRoot = join(frontendRoot, '.fumadocs-content', 'docs');
const publicImagesRoot = join(frontendRoot, 'public', 'docs-images');
const routeManifestPath = join(frontendRoot, 'next-site', 'docs-route-manifest.ts');
const buildRegion = process.env.NEXT_PUBLIC_REGION || process.env.VITE_REGION || process.env.FRONTEND_RELEASE_REGION || 'cn';
const defaultDocsOutputPrefix = buildRegion === 'global' ? 'en-us' : 'zh-cn';

/**
 * 国内站文档（lightvela.com/docs）单一数据源。
 * 按 GEO 导航方案组织为 9 大分组；`group` 字段决定侧边栏分组与顺序。
 * 部分为占位页（仅标题骨架，正文后续补齐），源 md 已在 src/content/docs 下创建。
 */
const cnDocs = [
  // 产品入门
  { slug: 'overview', title: 'LightVela 是什么', file: '01-overview.md', group: '产品入门', description: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，让每个人都能拥有认识你、记得你、越聊越懂你的专属 AI 伙伴。你的 Agent 7×24 小时在线、独立运行、随时可对话，模型、工具、人设都由你自己决定。' },
  { slug: 'quickstart', title: '快速开始', file: '02-quickstart.md', group: '产品入门', description: '5 分钟跑通第一个 LightVela 对话。' },
  { slug: 'core-concepts', title: '核心概念', file: '04-core-concepts.md', group: '产品入门', description: '理解 Hermes、模型、通道和技能。' },
  { slug: 'who-is-lightvela-for', title: 'LightVela 适合哪些人使用？', file: 'who-is-lightvela-for.md', group: '产品入门', description: 'LightVela 适合想拥有长期在线、越聊越懂你的专属 AI 伙伴，却不想碰服务器、容器和 API 鉴权的用户。本页梳理目标用户画像、典型使用场景与前置条件，帮你判断是否适合。' },
  // 账号、套餐与开通
  { slug: 'account', title: '账号与实名认证', file: '03-account.md', group: '账号、套餐与开通', description: '账号管理与实名认证流程。' },
  { slug: 'announcements/public-beta', title: '公测公告', file: 'announcements/public-beta.md', group: '账号、套餐与开通', description: '' },
  { slug: 'plans', title: '套餐说明', file: 'plans.md', group: '账号、套餐与开通', description: 'LightVela 提供启航 Launch、巡游 Cruise、远航 Voyage 三档套餐，各含独立云端环境、专属存储与每月模型积分。本页说明各档定位、规格、权益与计费，帮你按需选择。' },
  { slug: 'credits', title: '体验积分说明', file: 'credits.md', group: '账号、套餐与开通', description: '模型积分是 LightVela 计量 Hermes Agent 模型调用消耗的额度单位，随套餐按月发放、按 token 消耗。本页说明积分定义、发放、消耗方式及与套餐、模型的关系。' },
  { slug: 'create-first-hermes', title: '如何开通第一个 Hermes 智能体伙伴？', file: 'create-first-hermes.md', group: '账号、套餐与开通', description: '开通第一个 Hermes 智能体伙伴的完整流程：登录账号、完成实名认证、选择并开通套餐、平台自动创建，再配置模型与通道让 Agent 7×24 小时在线运行。' },
  // 功能与配置
  { slug: 'configuration/index', title: '配置总览', file: '05-configuration.md', group: '功能与配置', description: 'LightVela 管理台配置流程。' },
  { slug: 'configuration/model', title: '配置模型', file: 'configuration/model.md', group: '功能与配置', description: '接入和管理 Hermes 使用的大语言模型。' },
  { slug: 'configuration/channel-wechat', title: '配置通道 - 微信', file: 'configuration/channel-wechat.md', group: '功能与配置', description: '通过微信与 Hermes Agent 对话。' },
  { slug: 'configuration/channel-feishu', title: '配置通道 - 飞书', file: 'configuration/channel-feishu.md', group: '功能与配置', description: '通过飞书与 Hermes Agent 对话。' },
  { slug: 'configuration/channel-qq', title: '配置通道 - QQ', file: 'configuration/channel-qq.md', group: '功能与配置', description: '通过 QQ 与 Hermes Agent 对话。' },
  { slug: 'configuration/skill', title: '配置技能', file: 'configuration/skill.md', group: '功能与配置', description: '安装技能包，扩展 Hermes 能力。' },
  // 问题排查
  { slug: 'faq', title: '常见问题 FAQ', file: '07-faq.md', group: '问题排查', description: '' },
];

/** 国内站侧边栏分组顺序（GEO 导航方案的 9 大分组） */
const CN_GROUP_ORDER = [
  '产品入门',
  '账号、套餐与开通',
  '功能与配置',
  '问题排查',
  '联系与支持',
];

/** 国际站侧边栏分组顺序（GEO 导航方案的 9 大分组） */
const GLOBAL_GROUP_ORDER = [
  'Getting Started',
  'Plans & Activation',
  'Features & Configuration',
  'Use Cases',
  'Compare & Choose',
  'Troubleshooting',
  'Security, Privacy & Data',
  'Advanced',
  'Support',
];

const globalDocs = [
  {
    slug: 'overview',
    title: { 'en-US': 'What is LightVela', 'zh-CN': 'LightVela 是什么' },
    file: '01-overview.md',
    group: { 'en-US': 'Getting Started', 'zh-CN': '开始使用' },
    description: {
      'en-US': 'LightVela is a hosted Hermes Agent companion that keeps conversations and automations running in the cloud.',
      'zh-CN': '云端托管 Hermes Agent，越聊越懂的智能伙伴。',
    },
  },
  {
    slug: 'quickstart',
    title: { 'en-US': 'Quickstart', 'zh-CN': '快速开始' },
    file: '02-quickstart.md',
    group: { 'en-US': 'Getting Started', 'zh-CN': '开始使用' },
    description: {
      'en-US': 'Set up your first LightVela conversation in a few minutes.',
      'zh-CN': '几分钟跑通第一个 LightVela 对话。',
    },
  },
  {
    slug: 'core-concepts',
    title: { 'en-US': 'Core Concepts', 'zh-CN': '核心概念' },
    file: '04-core-concepts.md',
    group: { 'en-US': 'Getting Started', 'zh-CN': '开始使用' },
    description: {
      'en-US': 'Understand Hermes, models, channels, skills, and automations in LightVela.',
      'zh-CN': '理解 Hermes、模型、通道、技能和自动任务。',
    },
  },
  {
    slug: 'who-is-lightvela-for',
    title: { 'en-US': 'Who Is LightVela For?', 'zh-CN': 'LightVela 适合哪些人使用？' },
    file: 'who-is-lightvela-for.md',
    group: { 'en-US': 'Getting Started', 'zh-CN': '开始使用' },
    description: {
      'en-US': 'Learn who LightVela is designed for, including people who want a cloud-hosted personal AI companion without managing servers or infrastructure.',
      'zh-CN': '了解 LightVela 适合哪些用户，包括希望拥有云端托管个人 AI 伙伴、又不想管理服务器或基础设施的人。',
    },
  },
  {
    slug: 'plans',
    title: { 'en-US': 'Plans', 'zh-CN': '套餐说明' },
    file: 'plans.md',
    group: { 'en-US': 'Plans & Activation', 'zh-CN': '套餐与开通' },
    description: {
      'en-US': 'Compare LightVela plans, isolated cloud resources, monthly model credits, and the current international beta activation flow.',
      'zh-CN': '对比 LightVela 套餐、独立云端资源、每月模型积分与当前国际站内测开通流程。',
    },
  },
  {
    slug: 'credits',
    title: { 'en-US': 'Credits', 'zh-CN': '体验积分说明' },
    file: 'credits.md',
    group: { 'en-US': 'Plans & Activation', 'zh-CN': '套餐与开通' },
    description: {
      'en-US': 'Learn how LightVela model credits are allocated, consumed by token usage, and related to plans and models.',
      'zh-CN': '了解 LightVela 模型积分如何发放、如何随 token 用量消耗，以及与套餐和模型的关系。',
    },
  },
  {
    slug: 'create-first-hermes',
    title: { 'en-US': 'How Do I Activate My First Hermes Instance?', 'zh-CN': '如何开通第一个 Hermes 实例？' },
    file: 'create-first-hermes.md',
    group: { 'en-US': 'Plans & Activation', 'zh-CN': '套餐与开通' },
    description: {
      'en-US': 'Activate your first Hermes instance with Google or GitHub, an available plan, automatic cloud provisioning, and an international messaging channel.',
      'zh-CN': '使用 Google 或 GitHub、当前可用套餐、云端自动创建和国际消息通道开通第一个 Hermes 实例。',
    },
  },
  {
    slug: 'configuration/index',
    title: { 'en-US': 'Configuration Overview', 'zh-CN': '配置总览' },
    file: '05-configuration.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Review the LightVela console configuration flow.',
      'zh-CN': 'LightVela 管理台配置流程。',
    },
  },
  {
    slug: 'configuration/model',
    title: { 'en-US': 'Configure Models', 'zh-CN': '配置模型' },
    file: 'configuration/model.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect and manage the language models used by Hermes.',
      'zh-CN': '接入和管理 Hermes 使用的大语言模型。',
    },
  },
  {
    slug: 'configuration/channel-telegram',
    title: { 'en-US': 'Telegram', 'zh-CN': 'Telegram' },
    file: 'configuration/channel-telegram.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect Telegram to your Hermes Agent.',
      'zh-CN': '通过 Telegram 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-whatsapp',
    title: { 'en-US': 'WhatsApp', 'zh-CN': 'WhatsApp' },
    file: 'configuration/channel-whatsapp.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect WhatsApp to your Hermes Agent.',
      'zh-CN': '通过 WhatsApp 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-discord',
    title: { 'en-US': 'Discord', 'zh-CN': 'Discord' },
    file: 'configuration/channel-discord.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect Discord to your Hermes Agent.',
      'zh-CN': '通过 Discord 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-wechat',
    title: { 'en-US': 'WeChat', 'zh-CN': 'WeChat' },
    file: 'configuration/channel-wechat.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect WeChat to your Hermes Agent.',
      'zh-CN': '通过微信与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-qq',
    title: { 'en-US': 'QQ', 'zh-CN': 'QQ' },
    file: 'configuration/channel-qq.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect QQ to your Hermes Agent.',
      'zh-CN': '通过 QQ 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-wecom',
    title: { 'en-US': 'WeCom', 'zh-CN': '企业微信' },
    file: 'configuration/channel-wecom.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect WeCom to your Hermes Agent.',
      'zh-CN': '通过企业微信与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-feishu',
    title: { 'en-US': 'Lark', 'zh-CN': '飞书' },
    file: 'configuration/channel-feishu.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect Lark to your Hermes Agent.',
      'zh-CN': '通过飞书与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/skill',
    title: { 'en-US': 'Configure Skills', 'zh-CN': '配置技能' },
    file: 'configuration/skill.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Install skills to extend Hermes capabilities.',
      'zh-CN': '安装技能包，扩展 Hermes 能力。',
    },
  },
  {
    slug: 'configuration/memory',
    title: { 'en-US': 'Memory Management', 'zh-CN': '记忆管理' },
    file: 'configuration/memory.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Learn how Hermes stores and manages long-term memories and user profiles across devices and messaging channels.',
      'zh-CN': '了解 Hermes 如何跨设备和消息通道存储、管理长期记忆与用户画像。',
    },
  },
  {
    slug: 'configuration/automation',
    title: { 'en-US': 'Automations', 'zh-CN': '自动任务' },
    file: 'configuration/automation.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Create scheduled automations for your Hermes Agent.',
      'zh-CN': '为 Hermes Agent 创建定时自动任务。',
    },
  },
  {
    slug: 'configuration/files',
    title: { 'en-US': 'Cloud Storage', 'zh-CN': '云存储' },
    file: 'configuration/files.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'configuration/agent-chat',
    title: { 'en-US': 'Chat', 'zh-CN': '对话' },
    file: 'configuration/agent-chat.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Chat with Hermes and inspect conversation behavior.',
      'zh-CN': '与 Hermes 对话并查看会话行为。',
    },
  },
  {
    slug: 'configuration/diagnostics',
    title: { 'en-US': 'Diagnostics', 'zh-CN': '诊断中心' },
    file: 'configuration/diagnostics.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'configuration/multiple-models',
    title: { 'en-US': 'Model Switching', 'zh-CN': '模型切换' },
    file: 'configuration/multiple-models.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'use-cases/personal-ai-assistant',
    title: { 'en-US': 'How to Build a Personal AI Assistant with LightVela', 'zh-CN': '如何用 LightVela 搭建个人 AI 助手？' },
    file: 'use-cases/personal-ai-assistant.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'use-cases/chinese-messaging-channels',
    title: { 'en-US': 'How to Connect an AI Agent to Messaging Platforms', 'zh-CN': '如何把 AI Agent 接入消息平台？' },
    file: 'use-cases/chinese-messaging-channels.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'use-cases/daily-summary',
    title: { 'en-US': 'How to Create Daily Summaries with Hermes Agent', 'zh-CN': '如何用 Hermes Agent 做每日信息总结？' },
    file: 'use-cases/daily-summary.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'use-cases/hermes-agent-24-7',
    title: { 'en-US': 'How to Keep a Hermes Agent Online 24/7', 'zh-CN': '如何让 Hermes Agent 7×24 小时在线？' },
    file: 'use-cases/hermes-agent-24-7.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'use-cases/memory-and-knowledge',
    title: { 'en-US': 'How to Manage Long-Term Memory and Personal Knowledge with an Agent', 'zh-CN': '如何用 Agent 管理长期记忆和个人知识？' },
    file: 'use-cases/memory-and-knowledge.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'compare/lightvela-vs-localhost-ai-agent',
    title: { 'en-US': 'LightVela vs Selfhost Agent: Which is best?', 'zh-CN': 'LightVela vs 本地部署 Agent：哪个更好？' },
    file: 'compare/lightvela-vs-localhost-ai-agent.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'compare/lightvela-vs-hostinger',
    title: { 'en-US': 'LightVela vs Hostinger: Which is best VPS for agent hosting?', 'zh-CN': 'LightVela vs Hostinger：哪个 VPS 更适合托管 Agent？' },
    file: 'compare/lightvela-vs-hostinger.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'compare/lightvela-vs-manus',
    title: { 'en-US': 'LightVela vs Manus: Which is best to host your AI Agent?', 'zh-CN': 'LightVela vs Manus：哪个更适合托管你的 AI Agent？' },
    file: 'compare/lightvela-vs-manus.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'compare/lightvela-vs-chatgpt',
    title: { 'en-US': 'LightVela vs ChatGPT: Which is best to build your personal AI assistant?', 'zh-CN': 'LightVela vs ChatGPT：哪个更适合搭建个人 AI 助手？' },
    file: 'compare/lightvela-vs-chatgpt.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'compare/lightvela-vs-genspark',
    title: { 'en-US': 'LightVela vs Genspark: Which is best to host your AI Agent?', 'zh-CN': 'LightVela vs Genspark：哪个更适合托管你的 AI Agent？' },
    file: 'compare/lightvela-vs-genspark.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
  },
  {
    slug: 'faq/using-lightvela-safely',
    title: { 'en-US': 'Using LightVela Safely', 'zh-CN': '安全使用 LightVela' },
    file: 'faq/using-lightvela-safely.md',
    group: { 'en-US': 'Security, Privacy & Data', 'zh-CN': '安全、隐私与数据' },
    description: {
      'en-US': 'Guidance for using LightVela safely and responsibly.',
      'zh-CN': '安全、负责任地使用 LightVela 的建议。',
    },
  },
  {
    slug: 'contact-us',
    title: { 'en-US': 'Contact Us', 'zh-CN': '联系我们' },
    file: 'contact-us.md',
    group: { 'en-US': 'Support', 'zh-CN': '联系与支持' },
    description: {
      'en-US': 'Join the LightVela beta community, talk to the product team directly, and keep sending us your usage questions, product suggestions, and real-world feedback.',
      'zh-CN': '加入 LightVela 内测交流群，与产品团队面对面交流。继续把使用问题、产品建议和真实场景反馈给我们。',
    },
  },
];

const globalDocsForEnglish = globalDocs.filter(
  (doc) =>
    existsSync(join(sourceRoot, 'en', doc.file)) ||
    existsSync(join(sourceRoot, 'global', doc.file)),
);

const globalDocsForChinese = globalDocs.filter((doc) =>
  existsSync(join(sourceRoot, 'global', doc.file)),
);

const docSets = [
  {
    outputPrefix: URL_LANGS.EN_US,
    sourcePrefix: 'en',
    fallbackSourcePrefix: 'global',
    locale: LOCALES.EN_US,
    docs: globalDocsForEnglish,
    title: 'LightVela Docs',
  },
  {
    outputPrefix: URL_LANGS.ZH_CN,
    sourcePrefix: '',
    locale: LOCALES.ZH_CN,
    docs: cnDocs,
    title: 'LightVela 文档',
  },
  {
    outputPrefix: URL_LANGS.ZH_SG,
    sourcePrefix: 'global',
    locale: LOCALES.ZH_SG,
    docs: globalDocsForChinese,
    title: 'LightVela 文档',
  },
  {
    // 繁體中文文檔：与 zh-sg 同源（global 简体），生成时逐条做简→繁转换。
    outputPrefix: URL_LANGS.ZH_HANT,
    sourcePrefix: 'global',
    locale: LOCALES.ZH_HANT,
    docs: globalDocsForChinese,
    title: 'LightVela 文件',
    convertToTraditional: true,
  },
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function walkFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(path));
    } else {
      result.push(path);
    }
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textFor(value, locale) {
  if (typeof value === 'string') return value;
  // zh-SG / zh-Hant 均以简体（zh-CN）为文本底稿；zh-Hant 会在写盘时再做简→繁转换。
  if (locale === LOCALES.ZH_SG || locale === LOCALES.ZH_HANT) {
    return value?.[LOCALES.ZH_CN] ?? value?.[LOCALES.EN_US] ?? '';
  }
  return value?.[locale] ?? value?.[LOCALES.EN_US] ?? '';
}

function stripTitle(markdown, title) {
  return markdown.replace(new RegExp(`^#\\s+${escapeRegExp(title)}\\s*\\n+`), '').trim();
}

function allDocsForLinks(outputPrefix) {
  const localeDocs =
    outputPrefix === URL_LANGS.ZH_SG || outputPrefix === URL_LANGS.ZH_HANT
      ? globalDocsForChinese
      : globalDocsForEnglish;
  return [...cnDocs, ...localeDocs];
}

function fileToHrefFor(outputPrefix) {
  const prefix =
    outputPrefix && outputPrefix !== defaultDocsOutputPrefix
      ? `/${outputPrefix}/docs`
      : '/docs';
  const entries = allDocsForLinks(outputPrefix).flatMap((doc) => {
    const slug = doc.slug.replace(/\/index$/, '');
    return [
      [doc.file, `${prefix}/${slug}`],
      [doc.file.replace(/^configuration\//, ''), `${prefix}/${slug}`],
    ];
  });
  return new Map(entries);
}

function localizedImageName(imageName, locale) {
  if (locale !== 'en-US' || /-en\.[^.]+$/.test(imageName)) return imageName;
  const candidate = imageName.replace(/(\.[^.]+)$/, '-en$1');
  return existsSync(join(sourceRoot, 'images', candidate)) ? candidate : imageName;
}

function normalizeMarkdownLinks(markdown, currentFile, outputPrefix, locale) {
  const currentDir = dirname(currentFile);
  const fileToHref = fileToHrefFor(outputPrefix);
  return markdown
    .replace(/(!?\[[^\]]*]\()(?:(?:\.\.?\/)?images\/)([^)\s]+)([^)]*\))/g, (_match, prefix, imageName, suffix) => {
      return `${prefix}/docs-images/${localizedImageName(imageName, locale)}${suffix}`;
    })
    .replace(/(\[[^\]]+]\()(\.?\.?\/[^)#]+\.md)(#[^)]+)?(\))/g, (match, prefix, href, hash = '', suffix) => {
      const resolved = relative('.', join(currentDir, href)).replaceAll('\\', '/').replace(/^\.\//, '');
      const target = fileToHref.get(resolved);
      if (!target) return match;
      return `${prefix}${target}${hash}${suffix}`;
    });
}

function sourcePathFor(docSet, file) {
  const primary = join(sourceRoot, docSet.sourcePrefix, file);
  if (existsSync(primary)) return primary;
  if (docSet.fallbackSourcePrefix) {
    const fallback = join(sourceRoot, docSet.fallbackSourcePrefix, file);
    if (existsSync(fallback)) return fallback;
  }
  return primary;
}

function writeDoc(docSet, doc) {
  const convert = docSet.convertToTraditional ? convertTraditional : (value) => value;
  // rawTitle 为简体底稿，用于从原始 md 中剥离一级标题；title/description/body 写盘时再转繁。
  const rawTitle = textFor(doc.title, docSet.locale);
  const title = convert(rawTitle);
  const description = convert(textFor(doc.description, docSet.locale));
  const inputPath = sourcePathFor(docSet, doc.file);
  if (!existsSync(inputPath)) {
    throw new Error(`missing LightVela doc source: ${inputPath}`);
  }

  const raw = readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n');
  const body = convert(
    normalizeMarkdownLinks(stripTitle(raw, rawTitle), doc.file, docSet.outputPrefix, docSet.locale),
  );
  const outputPath = join(outputRoot, docSet.outputPrefix, `${doc.slug}.mdx`);
  ensureDir(dirname(outputPath));
  writeFileSync(
    outputPath,
    [
      '---',
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(description)}`,
      `source_path: ${JSON.stringify(relative(frontendRoot, inputPath))}`,
      '---',
      '',
      body,
      '',
    ].join('\n'),
  );
}

function copyImages() {
  const imagesRoot = join(sourceRoot, 'images');
  if (!existsSync(imagesRoot)) return;

  rmSync(publicImagesRoot, { recursive: true, force: true });
  ensureDir(publicImagesRoot);
  for (const file of walkFiles(imagesRoot)) {
    if (!statSync(file).isFile()) continue;
    const relativePath = relative(imagesRoot, file);
    const target = join(publicImagesRoot, relativePath);
    ensureDir(dirname(target));
    copyFileSync(file, target);
  }
}

/**
 * 数据驱动生成分组 meta。按 groupOrder 用 fumadocs 分隔符
 * `---分组名---` 列出页面，组内顺序与 docSet.docs 一致。
 */
function writeGroupedMeta(docSet, groupOrder, groupLocale) {
  const convert = docSet.convertToTraditional ? convertTraditional : (value) => value;
  const root = join(outputRoot, docSet.outputPrefix);
  ensureDir(root);

  const pages = [];
  for (const group of groupOrder) {
    const groupDocs = docSet.docs.filter((doc) => textFor(doc.group, groupLocale) === group);
    if (groupDocs.length === 0) continue;
    pages.push(`---${convert(textFor(groupDocs[0].group, docSet.locale))}---`);
    for (const doc of groupDocs) {
      // 根 meta 用相对该 locale 根的 slug 路径引用页面
      pages.push(doc.slug);
    }
  }

  writeFileSync(
    join(root, 'meta.json'),
    `${JSON.stringify({ title: docSet.title, pages }, null, 2)}\n`,
  );
}

function writeMetaForDocSet(docSet) {
  if (docSet.outputPrefix === URL_LANGS.ZH_CN) {
    writeGroupedMeta(docSet, CN_GROUP_ORDER, LOCALES.ZH_CN);
  } else {
    writeGroupedMeta(docSet, GLOBAL_GROUP_ORDER, LOCALES.EN_US);
  }
}

function slugSegments(slug) {
  return slug.replace(/\/index$/, '').split('/').filter(Boolean);
}

function writeRouteManifest() {
  const slugsByLocale = Object.fromEntries(
    docSets.map((docSet) => [
      docSet.outputPrefix,
      [
        [],
        ...docSet.docs.map((doc) => slugSegments(doc.slug)),
      ],
    ]),
  );

  const locales = docSets.map((docSet) => docSet.outputPrefix);
  writeFileSync(
    routeManifestPath,
    [
      `export const DOCS_ROUTE_LOCALES = ${JSON.stringify(locales)} as const;`,
      '',
      'export type DocsRouteLocale = (typeof DOCS_ROUTE_LOCALES)[number];',
      '',
      `export const DOCS_ROUTE_SLUGS = ${JSON.stringify(slugsByLocale, null, 2)} as const satisfies Record<DocsRouteLocale, readonly (readonly string[])[]>;`,
      '',
      'export function isDocsRouteSlug(locale: DocsRouteLocale, slug: readonly string[] = []) {',
      "  const key = slug.join('/');",
      "  return DOCS_ROUTE_SLUGS[locale].some((candidate) => candidate.join('/') === key);",
      '}',
      '',
    ].join('\n'),
  );
}

rmSync(outputRoot, { recursive: true, force: true });
ensureDir(outputRoot);
copyImages();
for (const docSet of docSets) {
  for (const doc of docSet.docs) writeDoc(docSet, doc);
  writeMetaForDocSet(docSet);
}
writeRouteManifest();

const total = docSets.reduce((count, docSet) => count + docSet.docs.length, 0);
console.log(`[sync-fumadocs-content] synced ${total} docs from ${relative(frontendRoot, sourceRoot)}`);
