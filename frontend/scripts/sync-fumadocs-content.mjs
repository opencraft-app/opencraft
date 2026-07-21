import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  { slug: 'create-first-hermes', title: '如何开通第一个 Hermes 实例？', file: 'create-first-hermes.md', group: '账号、套餐与开通', description: '开通第一个 Hermes 实例的完整流程：登录账号、完成实名认证、选择并开通套餐、平台自动创建实例，再配置模型与通道让 Agent 7×24 小时在线运行。' },
  // 功能与配置
  { slug: 'configuration/index', title: '配置总览', file: '05-configuration.md', group: '功能与配置', description: 'LightVela 管理台配置流程。' },
  { slug: 'configuration/model', title: '配置模型', file: 'configuration/model.md', group: '功能与配置', description: '接入和管理 Hermes 使用的大语言模型。' },
  { slug: 'configuration/channel-wechat', title: '配置通道 - 微信', file: 'configuration/channel-wechat.md', group: '功能与配置', description: '通过微信与 Hermes Agent 对话。' },
  { slug: 'configuration/channel-feishu', title: '配置通道 - 飞书', file: 'configuration/channel-feishu.md', group: '功能与配置', description: '通过飞书与 Hermes Agent 对话。' },
  { slug: 'configuration/channel-qq', title: '配置通道 - QQ', file: 'configuration/channel-qq.md', group: '功能与配置', description: '通过 QQ 与 Hermes Agent 对话。' },
  { slug: 'configuration/skill', title: '配置技能', file: 'configuration/skill.md', group: '功能与配置', description: '安装技能包，扩展 Hermes 能力。' },
  { slug: 'configuration/memory', title: '记忆管理', file: 'configuration/memory.md', group: '功能与配置', description: '' },
  { slug: 'configuration/files', title: '云端文件管理', file: 'configuration/files.md', group: '功能与配置', description: '' },
  { slug: 'configuration/automation', title: '自动任务', file: 'configuration/automation.md', group: '功能与配置', description: '' },
  { slug: 'configuration/diagnostics', title: '诊断中心', file: 'configuration/diagnostics.md', group: '功能与配置', description: '' },
  { slug: 'configuration/multiple-models', title: '多模型配置与切换', file: 'configuration/multiple-models.md', group: '功能与配置', description: '' },
  // 场景方案
  { slug: 'use-cases/personal-ai-assistant', title: '如何用 LightVela 搭建个人 AI 助手？', file: 'use-cases/personal-ai-assistant.md', group: '场景方案', description: '' },
  { slug: 'use-cases/hermes-agent-24-7', title: '如何让 Hermes Agent 7x24 小时在线？', file: 'use-cases/hermes-agent-24-7.md', group: '场景方案', description: '' },
  { slug: 'use-cases/chinese-messaging-channels', title: '如何把 AI Agent 接入微信 / QQ / 飞书？', file: 'use-cases/chinese-messaging-channels.md', group: '场景方案', description: '' },
  { slug: 'use-cases/daily-summary', title: '如何用 Hermes Agent 做每日信息总结？', file: 'use-cases/daily-summary.md', group: '场景方案', description: '' },
  { slug: 'use-cases/memory-and-knowledge', title: '如何用 Agent 管理长期记忆和个人知识？', file: 'use-cases/memory-and-knowledge.md', group: '场景方案', description: '' },
  { slug: 'use-cases/work-assistant', title: '如何搭建一个工作助手？', file: 'use-cases/work-assistant.md', group: '场景方案', description: '' },
  // 对比与选型
  { slug: 'compare/lightvela-vs-self-hosting-hermes', title: 'LightVela 和自托管 Hermes Agent 有什么区别？', file: 'compare/lightvela-vs-self-hosting-hermes.md', group: '对比与选型', description: '' },
  { slug: 'compare/cloud-vs-local-agent', title: 'LightVela 和本地运行 Agent 有什么区别？', file: 'compare/cloud-vs-local-agent.md', group: '对比与选型', description: '' },
  { slug: 'compare/ai-agent-vs-chatbot', title: 'LightVela 和普通聊天机器人有什么区别？', file: 'compare/ai-agent-vs-chatbot.md', group: '对比与选型', description: '' },
  { slug: 'compare/lightvela-vs-server-hosting', title: '使用 LightVela 还是自己买服务器部署？', file: 'compare/lightvela-vs-server-hosting.md', group: '对比与选型', description: '' },
  { slug: 'compare/model-selection', title: '如何为 Hermes Agent 选择合适的模型？', file: 'compare/model-selection.md', group: '对比与选型', description: '' },
  // 问题排查
  { slug: 'faq', title: '常见问题 FAQ', file: '07-faq.md', group: '问题排查', description: 'LightVela 常见问题。' },
  { slug: 'troubleshooting/agent-not-responding', title: 'Agent 无响应怎么办？', file: 'troubleshooting/agent-not-responding.md', group: '问题排查', description: '' },
  { slug: 'troubleshooting/model-errors', title: '模型调用失败怎么办？', file: 'troubleshooting/model-errors.md', group: '问题排查', description: '' },
  { slug: 'troubleshooting/channel-connection-failed', title: '微信 / QQ / 飞书通道连接失败怎么办？', file: 'troubleshooting/channel-connection-failed.md', group: '问题排查', description: '' },
  { slug: 'troubleshooting/automation-not-running', title: '自动任务没有执行怎么办？', file: 'troubleshooting/automation-not-running.md', group: '问题排查', description: '' },
  { slug: 'troubleshooting/skill-installation-failed', title: '技能安装失败怎么办？', file: 'troubleshooting/skill-installation-failed.md', group: '问题排查', description: '' },
  { slug: 'troubleshooting/rebuild-hermes', title: '如何重建 Hermes？', file: 'troubleshooting/rebuild-hermes.md', group: '问题排查', description: '' },
  // 安全、隐私与数据
  { slug: 'security/data-protection', title: 'LightVela 如何保护我的数据？', file: 'security/data-protection.md', group: '安全、隐私与数据', description: '' },
  { slug: 'security/data-storage', title: 'Agent 的对话、记忆和文件存储在哪里？', file: 'security/data-storage.md', group: '安全、隐私与数据', description: '' },
  { slug: 'security/instance-isolation', title: '每个 Hermes 实例是否独立隔离？', file: 'security/instance-isolation.md', group: '安全、隐私与数据', description: '' },
  { slug: 'security/model-training-policy', title: '是否会使用用户数据训练模型？', file: 'security/model-training-policy.md', group: '安全、隐私与数据', description: '' },
  { slug: 'security/export-and-delete-data', title: '数据能否导出或删除？', file: 'security/export-and-delete-data.md', group: '安全、隐私与数据', description: '' },
  // 进阶用法
  { slug: 'advanced/models-skills-automation', title: '如何组合模型、技能和自动任务？', file: 'advanced/models-skills-automation.md', group: '进阶用法', description: '' },
  { slug: 'advanced/agent-workflow-design', title: '如何设计一个稳定的个人 Agent 工作流？', file: 'advanced/agent-workflow-design.md', group: '进阶用法', description: '' },
  { slug: 'advanced/reduce-model-cost', title: '如何降低 Agent 的模型调用成本？', file: 'advanced/reduce-model-cost.md', group: '进阶用法', description: '' },
  { slug: 'advanced/automation-fit', title: '如何判断一个任务适不适合交给 Agent 自动执行？', file: 'advanced/automation-fit.md', group: '进阶用法', description: '' },
  { slug: 'advanced/multi-channel-hermes', title: '多通道接入时如何管理同一个 Hermes？', file: 'advanced/multi-channel-hermes.md', group: '进阶用法', description: '' },
  // 联系与支持
  { slug: 'contact-us', title: '联系我们', file: 'contact-us.md', group: '联系与支持', description: '加入 LightVela 内测交流群，与产品团队面对面交流。继续把使用问题、产品建议和真实场景反馈给我们。' },
  { slug: 'support/report-an-issue', title: '反馈问题时需要提供哪些信息？', file: 'support/report-an-issue.md', group: '联系与支持', description: '' },
];

/** 国内站侧边栏分组顺序（GEO 导航方案的 9 大分组） */
const CN_GROUP_ORDER = [
  '产品入门',
  '账号、套餐与开通',
  '功能与配置',
  '场景方案',
  '对比与选型',
  '问题排查',
  '安全、隐私与数据',
  '进阶用法',
  '联系与支持',
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
    slug: 'configuration/index',
    title: { 'en-US': 'Configuration Overview', 'zh-CN': '配置总览' },
    file: '05-configuration.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Review the LightVela console configuration flow.',
      'zh-CN': 'LightVela 管理台配置流程。',
    },
  },
  {
    slug: 'configuration/model',
    title: { 'en-US': 'Configure Models', 'zh-CN': '配置模型' },
    file: 'configuration/model.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect and manage the language models used by Hermes.',
      'zh-CN': '接入和管理 Hermes 使用的大语言模型。',
    },
  },
  {
    slug: 'configuration/channel-wechat',
    title: { 'en-US': 'WeChat', 'zh-CN': 'WeChat' },
    file: 'configuration/channel-wechat.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect WeChat to your Hermes Agent.',
      'zh-CN': '通过微信与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-telegram',
    title: { 'en-US': 'Telegram', 'zh-CN': 'Telegram' },
    file: 'configuration/channel-telegram.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect Telegram to your Hermes Agent.',
      'zh-CN': '通过 Telegram 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-whatsapp',
    title: { 'en-US': 'WhatsApp', 'zh-CN': 'WhatsApp' },
    file: 'configuration/channel-whatsapp.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect WhatsApp to your Hermes Agent.',
      'zh-CN': '通过 WhatsApp 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-discord',
    title: { 'en-US': 'Discord', 'zh-CN': 'Discord' },
    file: 'configuration/channel-discord.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect Discord to your Hermes Agent.',
      'zh-CN': '通过 Discord 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-qq',
    title: { 'en-US': 'QQ', 'zh-CN': 'QQ' },
    file: 'configuration/channel-qq.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect QQ to your Hermes Agent.',
      'zh-CN': '通过 QQ 与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-wecom',
    title: { 'en-US': 'WeCom', 'zh-CN': '企业微信' },
    file: 'configuration/channel-wecom.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect WeCom to your Hermes Agent.',
      'zh-CN': '通过企业微信与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/channel-feishu',
    title: { 'en-US': 'Lark', 'zh-CN': '飞书' },
    file: 'configuration/channel-feishu.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Connect Lark to your Hermes Agent.',
      'zh-CN': '通过飞书与 Hermes Agent 对话。',
    },
  },
  {
    slug: 'configuration/skill',
    title: { 'en-US': 'Configure Skills', 'zh-CN': '配置技能' },
    file: 'configuration/skill.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Install skills to extend Hermes capabilities.',
      'zh-CN': '安装技能包，扩展 Hermes 能力。',
    },
  },
  {
    slug: 'configuration/automation',
    title: { 'en-US': 'Automations', 'zh-CN': '自动任务' },
    file: 'configuration/automation.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Create scheduled automations for your Hermes Agent.',
      'zh-CN': '为 Hermes Agent 创建定时自动任务。',
    },
  },
  {
    slug: 'configuration/agent-chat',
    title: { 'en-US': 'Chat', 'zh-CN': '对话' },
    file: 'configuration/agent-chat.md',
    group: { 'en-US': 'Configuration Guide', 'zh-CN': '配置指南' },
    description: {
      'en-US': 'Chat with Hermes and inspect conversation behavior.',
      'zh-CN': '与 Hermes 对话并查看会话行为。',
    },
  },
  {
    slug: 'faq',
    title: { 'en-US': 'FAQ', 'zh-CN': '常见问题 FAQ' },
    file: '07-faq.md',
    group: { 'en-US': 'Reference', 'zh-CN': '参考' },
    description: {
      'en-US': 'Answers to common LightVela questions.',
      'zh-CN': 'LightVela 常见问题。',
    },
  },
  {
    slug: 'faq/using-lightvela-safely',
    title: { 'en-US': 'Using LightVela Safely', 'zh-CN': '安全使用 LightVela' },
    file: 'faq/using-lightvela-safely.md',
    group: { 'en-US': 'Reference', 'zh-CN': '参考' },
    description: {
      'en-US': 'Guidance for using LightVela safely and responsibly.',
      'zh-CN': '安全、负责任地使用 LightVela 的建议。',
    },
  },
  {
    slug: 'contact-us',
    title: { 'en-US': 'Contact Us', 'zh-CN': '联系我们' },
    file: 'contact-us.md',
    group: { 'en-US': 'Reference', 'zh-CN': '参考' },
    description: {
      'en-US': 'Join the LightVela beta community, talk to the product team directly, and keep sending us your usage questions, product suggestions, and real-world feedback.',
      'zh-CN': '加入 LightVela 内测交流群，与产品团队面对面交流。继续把使用问题、产品建议和真实场景反馈给我们。',
    },
  },
];

const docSets = [
  {
    outputPrefix: 'en-us',
    sourcePrefix: 'en',
    fallbackSourcePrefix: 'global',
    locale: 'en-US',
    docs: globalDocs,
    title: 'LightVela Docs',
    configurationTitle: 'Configuration Guide',
    referenceTitle: 'Reference',
  },
  {
    outputPrefix: 'zh-cn',
    sourcePrefix: '',
    locale: 'zh-CN',
    docs: cnDocs,
    title: 'LightVela 文档',
    configurationTitle: '配置指南',
    referenceTitle: '参考',
  },
  {
    outputPrefix: 'zh-sg',
    sourcePrefix: 'global',
    locale: 'zh-SG',
    docs: globalDocs,
    title: 'LightVela 文档',
    configurationTitle: '配置指南',
    referenceTitle: '参考',
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
  if (locale === 'zh-SG') return value?.['zh-CN'] ?? value?.['en-US'] ?? '';
  return value?.[locale] ?? value?.['en-US'] ?? '';
}

function stripTitle(markdown, title) {
  return markdown.replace(new RegExp(`^#\\s+${escapeRegExp(title)}\\s*\\n+`), '').trim();
}

function allDocsForLinks() {
  return [...cnDocs, ...globalDocs];
}

function fileToHrefFor(outputPrefix) {
  const prefix =
    outputPrefix && outputPrefix !== defaultDocsOutputPrefix
      ? `/${outputPrefix}/docs`
      : '/docs';
  const entries = allDocsForLinks().flatMap((doc) => {
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
  const title = textFor(doc.title, docSet.locale);
  const description = textFor(doc.description, docSet.locale);
  const inputPath = sourcePathFor(docSet, doc.file);
  if (!existsSync(inputPath)) {
    throw new Error(`missing LightVela doc source: ${inputPath}`);
  }

  const raw = readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n');
  const body = normalizeMarkdownLinks(stripTitle(raw, title), doc.file, docSet.outputPrefix, docSet.locale);
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
 * 国内站 meta：数据驱动。按 CN_GROUP_ORDER 用 fumadocs 分隔符 `---分组名---`
 * 生成 9 大分组，组内页面按 cnDocs 顺序用相对 slug 路径列出（扁平，不依赖子目录 meta）。
 */
function writeCnMeta(docSet) {
  const root = join(outputRoot, docSet.outputPrefix);
  ensureDir(root);

  const pages = [];
  for (const group of CN_GROUP_ORDER) {
    const groupDocs = docSet.docs.filter((doc) => doc.group === group);
    if (groupDocs.length === 0) continue;
    pages.push(`---${group}---`);
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
  const root = join(outputRoot, docSet.outputPrefix);
  const isCnLocale = docSet.outputPrefix === 'zh-cn';

  if (isCnLocale) {
    writeCnMeta(docSet);
    return;
  }

  ensureDir(root);
  writeFileSync(
    join(root, 'meta.json'),
    `${JSON.stringify(
      {
        title: docSet.title,
        pages: ['overview', 'quickstart', 'core-concepts', 'configuration', 'faq', 'contact-us'],
      },
      null,
      2,
    )}\n`,
  );
  ensureDir(join(root, 'configuration'));
  writeFileSync(
    join(root, 'configuration', 'meta.json'),
    `${JSON.stringify(
      {
        title: docSet.configurationTitle,
        pages: [
          'index',
          'model',
          'channel-wechat',
          'channel-telegram',
          'channel-whatsapp',
          'channel-discord',
          'channel-feishu',
          'channel-qq',
          'channel-wecom',
          'skill',
          'automation',
          'agent-chat',
        ],
      },
      null,
      2,
    )}\n`,
  );
  ensureDir(join(root, 'faq'));
  writeFileSync(
    join(root, 'faq', 'meta.json'),
    `${JSON.stringify(
      {
        title: docSet.referenceTitle,
        pages: ['using-lightvela-safely'],
      },
      null,
      2,
    )}\n`,
  );
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
