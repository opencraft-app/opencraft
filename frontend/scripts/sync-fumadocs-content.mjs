import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as OpenCC from 'opencc-js';

import { createLastUpdatedResolver } from './docs-last-updated.mjs';

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
  ID_ID: 'id-ID',
  ES: 'es',
});

/** URL 前缀（对应 fumadocs 输出目录），与 `PUBLIC_URL_LANGS` 保持一致。 */
const URL_LANGS = Object.freeze({
  EN_US: 'en-us',
  ZH_CN: 'zh-cn',
  ZH_SG: 'zh-sg',
  ZH_HANT: 'zh-hant',
  ID_ID: 'id-id',
  ES: 'es',
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
/** 只读清单，构建期绝不跑 git（CI 是浅克隆，git 时间不可信）。 */
const resolveLastUpdated = createLastUpdatedResolver();
const buildRegion = process.env.NEXT_PUBLIC_REGION || process.env.VITE_REGION || process.env.FRONTEND_RELEASE_REGION || 'cn';
const defaultDocsOutputPrefix = buildRegion === 'global' ? 'en-us' : 'zh-cn';

/**
 * 国内站文档（lightvela.com/docs）单一数据源。
 * 按 GEO 导航方案组织为 9 大分组；`group` 字段决定侧边栏分组与顺序。
 * 部分为占位页（仅标题骨架，正文后续补齐），源 md 已在 src/content/docs 下创建。
 */
const cnDocs = [
  // 产品入门
  { slug: 'overview', title: 'LightVela 是什么', file: '01-overview.md', group: '产品入门', description: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，让每个人都能拥有认识你、记得你、越聊越懂你的专属 AI 伙伴。你的 Agent 7×24 小时在线、独立运行、随时可对话，模型、工具、人设都由你自己决定。', hideDescription: true },
  { slug: 'quickstart', title: '快速开始', file: '02-quickstart.md', group: '产品入门', description: '5 分钟跑通第一个 LightVela 对话。', hideDescription: true },
  { slug: 'core-concepts', title: '核心概念', file: '04-core-concepts.md', group: '产品入门', description: '理解 Hermes、模型、通道和技能。', hideDescription: true },
  { slug: 'who-is-lightvela-for', title: 'LightVela 适合哪些人使用？', file: 'who-is-lightvela-for.md', group: '产品入门', description: 'LightVela 适合想拥有长期在线、越聊越懂你的专属 AI 伙伴，却不想碰服务器、容器和 API 鉴权的用户。本页梳理目标用户画像、典型使用场景与前置条件，帮你判断是否适合。', hideDescription: true },
  // 账号、套餐与开通
  { slug: 'account', title: '账号与实名认证', file: '03-account.md', group: '账号、套餐与开通', description: '账号管理与实名认证流程。', hideDescription: true },
  { slug: 'announcements/public-beta', title: 'LightVela 付费版本公告', file: 'announcements/public-beta.md', group: '账号、套餐与开通', description: '', hideDescription: true },
  { slug: 'plans', title: '套餐管理', file: 'plans.md', group: '账号、套餐与开通', description: 'LightVela 套餐管理文档：查看启航 Launch、巡游 Cruise、启航 Launch AI、巡游 Cruise AI 的权益与标准原价，了解续费流程、套餐生命周期和腾讯云智能客服退款规则。', hideDescription: true },
  { slug: 'credits', title: 'AI 积分说明', file: 'credits.md', group: '账号、套餐与开通', description: 'AI 积分是 LightVela 计量 Hermes Agent 模型调用消耗的额度单位，随套餐按月发放、按 Token 消耗。本页说明积分定义、发放、消耗方式及与套餐的关系。', hideDescription: true },
  { slug: 'create-first-hermes', title: '如何开通第一个 Hermes 智能体伙伴？', file: 'create-first-hermes.md', group: '账号、套餐与开通', description: '开通第一个 Hermes 智能体伙伴的完整流程：登录账号、完成实名认证、选择并开通套餐、平台自动创建，再配置模型与通道让 Agent 7×24 小时在线运行。', hideDescription: true },
  // 功能与配置
  { slug: 'configuration/index', title: '配置总览', file: '05-configuration.md', group: '功能与配置', description: 'LightVela 管理台配置流程。', hideDescription: true },
  { slug: 'configuration/model', title: '配置模型', file: 'configuration/model.md', group: '功能与配置', description: '接入和管理 Hermes 使用的大语言模型。', hideDescription: true },
  { slug: 'configuration/channel-wechat', title: '配置通道 - 微信', file: 'configuration/channel-wechat.md', group: '功能与配置', description: '通过微信与 Hermes Agent 对话。', hideDescription: true },
  { slug: 'configuration/channel-qq', title: '配置通道 - QQ', file: 'configuration/channel-qq.md', group: '功能与配置', description: '通过 QQ 与 Hermes Agent 对话。', hideDescription: true },
  { slug: 'configuration/channel-wecom', title: '配置通道 - 企业微信', file: 'configuration/channel-wecom.md', group: '功能与配置', description: '通过企业微信与 Hermes Agent 对话。', hideDescription: true },
  { slug: 'configuration/channel-feishu', title: '配置通道 - 飞书', file: 'configuration/channel-feishu.md', group: '功能与配置', description: '通过飞书与 Hermes Agent 对话。', hideDescription: true },
  { slug: 'configuration/skill', title: '配置技能', file: 'configuration/skill.md', group: '功能与配置', description: '安装技能包，扩展 Hermes 能力。', hideDescription: true },
  { slug: 'configuration/personality', title: '人设', file: 'configuration/personality.md', group: '功能与配置', description: '选择并注入 Soul，定义 Hermes Agent 的角色、语气、优先级与行为边界。', hideDescription: true },
  { slug: 'configuration/memory', title: '记忆管理', file: 'configuration/memory.md', group: '功能与配置', description: '了解 Hermes 如何保存和管理长期记忆与用户画像。', hideDescription: true },
  { slug: 'configuration/automation', title: '自动任务', file: 'configuration/automation.md', group: '功能与配置', description: '为 Hermes Agent 创建定时自动任务。', hideDescription: true },
  { slug: 'configuration/files', title: '云存储', file: 'configuration/files.md', group: '功能与配置', description: '管理 Agent 使用的云端文件和工作资料。', hideDescription: true },
  { slug: 'configuration/agent-chat', title: '对话', file: 'configuration/agent-chat.md', group: '功能与配置', description: '通过聊天窗口与 Hermes Agent 交互。', hideDescription: true },
  { slug: 'configuration/diagnostics', title: '诊断中心', file: 'configuration/diagnostics.md', group: '功能与配置', description: '查看日志并排查 Hermes Agent 的异常情况。', hideDescription: true },
  { slug: 'configuration/advanced-settings', title: '高级设置', file: 'configuration/advanced-settings.md', group: '功能与配置', description: '查看并调整 Hermes Agent 的安全、记忆和上下文管理配置。', hideDescription: true },
  { slug: 'configuration/multiple-models', title: '模型切换', file: 'configuration/multiple-models.md', group: '功能与配置', description: '在多个已配置模型之间切换 Agent 当前使用的模型。', hideDescription: true },
  { slug: 'configuration/deepseek-harness', title: 'DeepSeek Harness', file: 'configuration/deepseek-harness.md', group: '功能与配置', description: '在 LightVela 中安装和管理 DeepSeek Harness Labs 运行环境。', hideDescription: true },
  // Hermes Agent 解读（长文科普，帮助用户理解 Hermes Agent 的设计与原理）
  { slug: 'hermes-agent/hermes-vs-openclaw', title: 'Hermes Agent vs OpenClaw：两个开源 Agent 的根本差别', file: 'hermes-agent/01-hermes-vs-openclaw.md', group: 'Hermes Agent 解读', description: '对比 Hermes Agent 与 OpenClaw 两个开源 Agent 在长期记忆、Skill 生态、多平台接入等维度的根本差别，帮你判断哪一个更贴近你的使用场景。', hideDescription: true },
  { slug: 'hermes-agent/why-hermes-remembers-you', title: 'Hermes Agent 是怎么"记住你"的？', file: 'hermes-agent/02-why-hermes-remembers-you.md', group: 'Hermes Agent 解读', description: '揭秘 Hermes Agent 长期记忆背后的四层分工系统：USER.md、MEMORY.md、SQLite+FTS5 会话档案与 Skills，以及写入/召回时机的工程实现。', hideDescription: true },
  { slug: 'hermes-agent/user-md-vs-memory-md', title: 'USER.md 与 MEMORY.md 为什么不能合并？', file: 'hermes-agent/03-user-md-vs-memory-md.md', group: 'Hermes Agent 解读', description: '从容量、加载策略、更新语义三条硬约束，解释 Hermes Agent 为什么把长期记忆拆成 USER.md 与 MEMORY.md 两份笔记，而不是合并成一份。', hideDescription: true },
  { slug: 'hermes-agent/hermes-memory-curation', title: 'Hermes Agent 的长期记忆治理：少而准的四条铁律', file: 'hermes-agent/04-hermes-memory-curation.md', group: 'Hermes Agent 解读', description: '解析 Hermes Agent 长期记忆治理的四条铁律：有界、冻结、透明、自我整合，以及它们如何保证记忆"少而准"而不是"多而乱"。', hideDescription: true },
  { slug: 'hermes-agent/memory-vs-skill', title: 'Memory vs Skill：陈述性记忆与程序性记忆', file: 'hermes-agent/05-memory-vs-skill.md', group: 'Hermes Agent 解读', description: '从认知心理学的陈述性记忆与程序性记忆出发，解释 Hermes Agent 为什么把长期记忆拆成 Memory 与 Skill 两条腿，以及两者的触发方式、表达形式、演化速度差异。', hideDescription: true },
  { slug: 'hermes-agent/model-vs-agent-layer', title: 'Hermes Agent 的"大脑"可以替换吗？模型层与 Agent 层如何分工', file: 'hermes-agent/06-model-vs-agent-layer.md', group: 'Hermes Agent 解读', description: '拆解模型层与 Agent 层的分工：换模型只替换推理引擎，人格、记忆、技能、自动任务都存放在模型之外，因此不会被带走。', hideDescription: true },
  { slug: 'hermes-agent/message-gateway', title: '一个 Agent 如何同时出现在多个聊天软件里？拆解消息网关机制', file: 'hermes-agent/07-message-gateway.md', group: 'Hermes Agent 解读', description: '拆解消息网关的标准化、路由与投递三件事，解释为什么多个通道可以共享同一个 Agent 的人格与记忆。', hideDescription: true },
  { slug: 'hermes-agent/automation-scheduling', title: 'Hermes Agent 如何按时主动找你？拆解自动化调度与定时任务机制', file: 'hermes-agent/08-automation-scheduling.md', group: 'Hermes Agent 解读', description: '解释自动任务如何把"何时执行、执行什么、发到哪里"保存成可重复调度的配置，以及怎样写出无人在场也能稳定执行的任务说明。', hideDescription: true },
  { slug: 'hermes-agent/model-switching-memory', title: '切换模型会让 Agent"失忆"吗？模型、人格与记忆的解耦设计', file: 'hermes-agent/09-model-switching-memory.md', group: 'Hermes Agent 解读', description: '区分"表达风格变化"与"记忆丢失"：切换模型不清除记忆与技能，并给出一步就能判断的验证方法。', hideDescription: true },
  { slug: 'hermes-agent/persona-user-memory', title: 'Hermes Agent 的性格从哪里来？Persona、用户偏好与长期记忆如何共同作用', file: 'hermes-agent/10-persona-user-memory.md', group: 'Hermes Agent 解读', description: '解释 SOUL.md、USER.md 与 MEMORY.md 的三层分工，以及为什么变化频率不同的内容必须分开存放。', hideDescription: true },
  { slug: 'hermes-agent/workspace-context-storage', title: 'Hermes Agent 把文件放在哪里？工作目录、上下文文件与存储机制', file: 'hermes-agent/11-workspace-context-storage.md', group: 'Hermes Agent 解读', description: '区分工作目录、上下文文件与云存储三类位置的职责与边界，并说明敏感信息不应写入长期上下文的原因。', hideDescription: true },
  { slug: 'hermes-agent/skills-self-improvement', title: 'Agent 为什么会越用越顺手？技能沉淀、自我改进与复用机制', file: 'hermes-agent/12-skills-self-improvement.md', group: 'Hermes Agent 解读', description: '解释 Memory 与 Skill 两类积累的差异，以及一份合格 Skill 必须写清的四件事：何时使用、执行步骤、成功标准、不可越过的边界。', hideDescription: true },
  // 对比与选型
  { slug: 'compare/lightvela-vs-manus', title: 'LightVela vs Manus：哪个更适合托管你的 AI Agent？', file: 'compare/lightvela-vs-manus.md', group: '对比与选型', description: '' },
  { slug: 'compare/lightvela-vs-localhost-ai-agent', title: 'LightVela vs 本地部署 Agent：哪个更好？', file: 'compare/lightvela-vs-localhost-ai-agent.md', group: '对比与选型', description: '' },
  { slug: 'compare/lightvela-vs-ai-chatbot', title: 'LightVela vs AI Chatbot：哪个更适合搭建个人 AI 助手？', file: 'compare/lightvela-vs-ai-chatbot.md', group: '对比与选型', description: '' },
  // 问题排查
  { slug: 'faq', title: '常见问题 FAQ', file: '07-faq.md', group: '问题排查', description: '', hideDescription: true },
  // 联系与支持
  { slug: 'contact-us', title: '联系我们', file: 'contact-us.md', group: '联系与支持', description: '加入 LightVela 用户交流群，与产品团队面对面交流。继续把使用问题、产品建议和真实场景反馈给我们。', hideDescription: true },
];

/** 国内站侧边栏分组顺序（GEO 导航方案的 9 大分组） */
const CN_GROUP_ORDER = [
  '产品入门',
  '账号、套餐与开通',
  '功能与配置',
  '对比与选型',
  'Hermes Agent 解读',
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
  'Hermes Agent Deep Dive',
  'Troubleshooting',
  'Advanced',
  'Support',
];

const ES_GROUP_LABELS = {
  'Getting Started': 'Primeros pasos',
  'Plans & Activation': 'Planes y activación',
  'Features & Configuration': 'Funciones y configuración',
  'Use Cases': 'Casos de uso',
  'Compare & Choose': 'Comparar y elegir',
  'Hermes Agent Deep Dive': 'Análisis de Hermes Agent',
  Troubleshooting: 'Solución de problemas',
  Advanced: 'Avanzado',
  Support: 'Soporte',
};

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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
  },
  {
    slug: 'plans',
    title: { 'en-US': 'Plans', 'zh-CN': '套餐说明' },
    file: 'plans.md',
    group: { 'en-US': 'Plans & Activation', 'zh-CN': '套餐与开通' },
    description: {
      'en-US': 'Compare LightVela plans, isolated cloud resources, monthly AI credits, refund rules, and email-based refund application steps.',
      'zh-CN': '对比 LightVela 套餐、独立云端资源、每月 AI 积分，并了解退款规则与邮件申请步骤。',
    },
    hideDescription: true,
  },
  {
    slug: 'announcements/public-beta',
    title: { 'en-US': 'LightVela Paid Version Announcement', 'zh-CN': 'LightVela 付费版本公告' },
    file: 'announcements/public-beta.md',
    group: { 'en-US': 'Plans & Activation', 'zh-CN': '套餐与开通' },
    description: {
      'en-US': 'LightVela plans to enter public beta and start billing on August 18, 2026 (Singapore Time). Beta users get one additional month on their existing plan, and new users can try Launch free for 14 days after public beta and billing start.',
      'zh-CN': 'LightVela 计划将于 2026 年 8 月 18 日（新加坡时间）起转入公测并开启计费；正式转入公测并开启计费后，内测用户现有套餐的有效期将额外延长 1 个月。',
    },
    hideDescription: true,
  },
  {
    slug: 'credits',
    title: { 'en-US': 'Credits', 'zh-CN': '体验积分说明' },
    file: 'credits.md',
    group: { 'en-US': 'Plans & Activation', 'zh-CN': '套餐与开通' },
    description: {
      'en-US': 'Learn how LightVela model credits are allocated, consumed by token usage, and related to plans and models.',
      'zh-CN': '了解 LightVela 模型积分如何发放、如何随 token 用量消耗，以及与套餐、模型的关系。',
    },
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
  },
  {
    slug: 'configuration/channel-slack',
    title: { 'en-US': 'Slack', 'zh-CN': 'Slack' },
    file: 'configuration/channel-slack.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Connect Slack to your Hermes Agent with a Slack Bot Token and App Token.',
      'zh-CN': '通过 Slack Bot Token 和 App Token 将 Hermes Agent 接入 Slack。',
    },
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
  },
  {
    slug: 'configuration/personality',
    title: { 'en-US': 'Souls', 'zh-CN': '人设' },
    file: 'configuration/personality.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Choose and apply a Soul to define a Hermes Agent\'s role, voice, priorities, and behavioral boundaries.',
      'zh-CN': '选择并注入 Soul，定义 Hermes Agent 的角色、语气、优先级与行为边界。',
    },
    hideDescription: true,
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
    hideDescription: true,
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
    hideDescription: true,
  },
  {
    slug: 'configuration/files',
    title: { 'en-US': 'Cloud Storage', 'zh-CN': '云存储' },
    file: 'configuration/files.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
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
    hideDescription: true,
  },
  {
    slug: 'configuration/diagnostics',
    title: { 'en-US': 'Diagnostics', 'zh-CN': '诊断中心' },
    file: 'configuration/diagnostics.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'configuration/advanced-settings',
    title: { 'en-US': 'Advanced Settings', 'zh-CN': '高级设置' },
    file: 'configuration/advanced-settings.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Review and adjust Hermes Agent safety, memory, and context-management settings.',
      'zh-CN': '查看并调整 Hermes Agent 的安全、记忆和上下文管理配置。',
    },
    hideDescription: true,
  },
  {
    slug: 'configuration/multiple-models',
    title: { 'en-US': 'Model Switching', 'zh-CN': '模型切换' },
    file: 'configuration/multiple-models.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'configuration/deepseek-harness',
    title: { 'en-US': 'DeepSeek Harness', 'zh-CN': 'DeepSeek Harness' },
    file: 'configuration/deepseek-harness.md',
    group: { 'en-US': 'Features & Configuration', 'zh-CN': '功能与配置' },
    description: {
      'en-US': 'Install and manage the DeepSeek Harness Labs runtime alongside Hermes Agent in LightVela.',
      'zh-CN': '在 LightVela 中与 Hermes Agent 并行安装和管理 DeepSeek Harness Labs 运行环境。',
    },
    hideDescription: true,
  },
  {
    slug: 'use-cases/personal-ai-assistant',
    title: { 'en-US': 'How to Build a Personal AI Assistant with LightVela', 'zh-CN': '如何用 LightVela 搭建个人 AI 助手？' },
    file: 'use-cases/personal-ai-assistant.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/chinese-messaging-channels',
    title: { 'en-US': 'How to Connect an AI Agent to Messaging Platforms', 'zh-CN': '如何把 AI Agent 接入消息平台？' },
    file: 'use-cases/chinese-messaging-channels.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/telegram-persona-agent',
    title: { 'en-US': 'How to Configure a Hermes Agent with a Distinct Personality in Telegram', 'zh-CN': '如何在 Telegram 中配置一个具有独立人格的 Hermes Agent？' },
    file: 'use-cases/telegram-persona-agent.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/whatsapp-persona-agent',
    title: { 'en-US': 'How to Configure a Hermes Agent with a Distinct Personality in WhatsApp', 'zh-CN': '如何在 WhatsApp 中配置一个具有独立人格的 Hermes Agent？' },
    file: 'use-cases/whatsapp-persona-agent.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/im-agent-persona-soul-md',
    title: { 'en-US': "How to Define an IM Agent's Role, Personality, and Voice with SOUL.md", 'zh-CN': '如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式？' },
    file: 'use-cases/im-agent-persona-soul-md.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/im-agent-skill-scenarios',
    title: { 'en-US': 'How to Turn an IM Agent into a Customer-Service, Community, or Companion Assistant with Skills', 'zh-CN': '如何通过 Skill 把 IM Agent 变成客服、社群助手或 AI 伴侣？' },
    file: 'use-cases/im-agent-skill-scenarios.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/multi-channel-personality-memory',
    title: { 'en-US': 'How to Connect One Agent to Telegram and WhatsApp While Keeping One Personality and Long-Term Memory', 'zh-CN': '如何让一个 Agent 同时接入 Telegram 和 WhatsApp，并保持统一人格与长期记忆？' },
    file: 'use-cases/multi-channel-personality-memory.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/telegram-group-community-assistant',
    title: { 'en-US': 'How to Use a Telegram Group AI Community Assistant: Q&A, Summaries, and Reminders', 'zh-CN': '如何使用 Telegram 群组 AI 社群助手：问答、摘要与提醒？' },
    file: 'use-cases/telegram-group-community-assistant.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/whatsapp-24-7-customer-service',
    title: { 'en-US': 'How to Configure 24/7 AI Customer Service in WhatsApp: Personality, Knowledge, Skills, and Automations', 'zh-CN': '如何在 WhatsApp 中配置 24/7 AI 客服：人格、知识、技能与自动化？' },
    file: 'use-cases/whatsapp-24-7-customer-service.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/lifelike-im-agent-rhythm-social-memory',
    title: { 'en-US': 'How to Design a More Natural IM Agent: Conversation Rhythm, Group Norms, and Long-Term Social Memory', 'zh-CN': '如何设计更像真人的 IM Agent：对话节奏、群体规范与长期社交记忆？' },
    file: 'use-cases/lifelike-im-agent-rhythm-social-memory.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/telegram-whatsapp-safety-boundaries',
    title: { 'en-US': 'How to Design Safety Boundaries for Telegram and WhatsApp Agents: Authorization, Group Rules, and Sensitive Actions', 'zh-CN': '如何为 Telegram 和 WhatsApp Agent 设计安全边界：授权、群聊规则与敏感操作？' },
    file: 'use-cases/telegram-whatsapp-safety-boundaries.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/daily-summary',
    title: { 'en-US': 'How to Create Daily Summaries with Hermes Agent', 'zh-CN': '如何用 Hermes Agent 做每日信息总结？' },
    file: 'use-cases/daily-summary.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/hermes-agent-24-7',
    title: { 'en-US': 'How to Keep a Hermes Agent Online 24/7', 'zh-CN': '如何让 Hermes Agent 7×24 小时在线？' },
    file: 'use-cases/hermes-agent-24-7.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/memory-and-knowledge',
    title: { 'en-US': 'How to Manage Long-Term Memory and Personal Knowledge with an Agent', 'zh-CN': '如何用 Agent 管理长期记忆和个人知识？' },
    file: 'use-cases/memory-and-knowledge.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/discord-community-agent',
    title: { 'en-US': 'Meet LightVela for Discord: Your AI Agent Discord Bot Serving Your Channel', 'zh-CN': 'Meet LightVela for Discord：服务你所在频道的 AI Agent Discord Bot' },
    file: 'use-cases/discord-community-agent.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': 'Configure a shared Discord Agent for community questions, onboarding, and event support.', 'zh-CN': '配置共享 Discord Agent，处理社群问答、新成员引导和活动支持。' },
    hideDescription: true,
  },
  {
    slug: 'use-cases/discord-event-agent',
    title: { 'en-US': 'Empower your Discord Event Bot with AI-Agentic Capabilities', 'zh-CN': '如何用 AI Agent 能力增强 Discord 活动机器人？' },
    file: 'use-cases/discord-event-agent.md',
    group: { 'en-US': 'Use Cases', 'zh-CN': '场景方案' },
    description: { 'en-US': 'Use a Discord Agent to answer event questions, support reminders, and keep event operations consistent.', 'zh-CN': '使用 Discord Agent 回答活动问题、支持提醒，并让活动运营信息保持一致。' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-localhost-ai-agent',
    title: { 'en-US': 'LightVela vs Selfhost Agent: Which is best?', 'zh-CN': 'LightVela vs 本地部署 Agent：哪个更好？' },
    file: 'compare/lightvela-vs-localhost-ai-agent.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-hostinger',
    title: { 'en-US': 'LightVela vs Hostinger: Which is best VPS for agent hosting?', 'zh-CN': 'LightVela vs Hostinger：哪个 VPS 更适合托管 Agent？' },
    file: 'compare/lightvela-vs-hostinger.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-manus',
    title: { 'en-US': 'LightVela vs Manus: Which is best to host your AI Agent?', 'zh-CN': 'LightVela vs Manus：哪个更适合托管你的 AI Agent？' },
    file: 'compare/lightvela-vs-manus.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-chatgpt',
    title: { 'en-US': 'LightVela vs ChatGPT: Which is best to build your personal AI assistant?', 'zh-CN': 'LightVela vs ChatGPT：哪个更适合搭建个人 AI 助手？' },
    file: 'compare/lightvela-vs-chatgpt.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-genspark',
    title: { 'en-US': 'LightVela vs Genspark: Which is best to host your AI Agent?', 'zh-CN': 'LightVela vs Genspark：哪个更适合托管你的 AI Agent？' },
    file: 'compare/lightvela-vs-genspark.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': '', 'zh-CN': '' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-grok-bot',
    title: { 'en-US': 'LightVela vs Grok Bot: Which is best to run your personal AI Agent?', 'zh-CN': 'LightVela vs Grok Bot：哪个更适合运行你的个人 AI Agent？' },
    file: 'compare/lightvela-vs-grok-bot.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': 'Compare LightVela and Grok Bot for running a personal AI Agent, from persistent routines and messaging access to cloud computers and delegated work.', 'zh-CN': '对比 LightVela 与 Grok Bot 运行个人 AI Agent 的方式，了解个人工作流、消息入口、云端电脑与委托式工作的差异。' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-mira',
    title: { 'en-US': 'LightVela vs Mira: Which is best to run your personal AI Agent?', 'zh-CN': 'LightVela vs Mira：哪个更适合运行你的个人 AI Agent？' },
    file: 'compare/lightvela-vs-mira.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': 'Compare LightVela and Mira for running a personal AI Agent, from persistent routines and messaging channels to Telegram-first teamwork and chat-based actions.', 'zh-CN': '对比 LightVela 与 Mira 运行个人 AI Agent 的方式，了解持久化工作流、消息通道、Telegram 协作与聊天驱动操作的差异。' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-viktor',
    title: { 'en-US': 'LightVela vs Viktor.com: Which is best to run your personal AI Agent?', 'zh-CN': 'LightVela vs Viktor.com：哪个更适合你的个人 AI Agent？' },
    file: 'compare/lightvela-vs-viktor.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': 'Compare LightVela and Viktor.com for running a personal AI Agent, from persistent personal assistance to shared team workflows across business tools.', 'zh-CN': '对比 LightVela 与 Viktor.com 运行个人 AI Agent 的方式，了解持久化个人助手与跨业务工具团队工作流的差异。' },
    hideDescription: true,
  },
  {
    slug: 'compare/lightvela-vs-today-ai',
    title: { 'en-US': 'LightVela vs Today.AI: Which is best for an always-on personal AI assistant?', 'zh-CN': 'LightVela vs Today.AI：哪个更适合运行始终在线的个人 AI 助手？' },
    file: 'compare/lightvela-vs-today-ai.md',
    group: { 'en-US': 'Compare & Choose', 'zh-CN': '对比与选型' },
    description: { 'en-US': 'Compare LightVela and Today.AI for an always-on personal AI assistant, from explicit Agent hosting and Automations to proactive personal context across devices.', 'zh-CN': '对比 LightVela 与 Today.AI 的始终在线个人 AI 助手体验，了解明确的 Agent 托管与自动任务，以及跨设备的主动式个人上下文。' },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/hermes-vs-openclaw',
    title: {
      'en-US': 'Hermes Agent vs OpenClaw: Fundamental Differences Between Two Open-Source Agents',
      'zh-CN': 'Hermes Agent vs OpenClaw：两个开源 Agent 的根本差别',
    },
    file: 'hermes-agent/01-hermes-vs-openclaw.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Compare Hermes Agent and OpenClaw across long-term memory, skill ecosystems, and multi-platform integration to see which open-source agent fits your use case.',
      'zh-CN': '对比 Hermes Agent 与 OpenClaw 两个开源 Agent 在长期记忆、Skill 生态、多平台接入等维度的根本差别，帮你判断哪一个更贴近你的使用场景。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/why-hermes-remembers-you',
    title: {
      'en-US': 'How Does Hermes Agent Remember You?',
      'zh-CN': 'Hermes Agent 是怎么"记住你"的？',
    },
    file: 'hermes-agent/02-why-hermes-remembers-you.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Uncover the four-layer long-term memory system behind Hermes Agent: USER.md, MEMORY.md, SQLite+FTS5 conversation archive, and Skills, plus how writes and recalls are engineered.',
      'zh-CN': '揭秘 Hermes Agent 长期记忆背后的四层分工系统：USER.md、MEMORY.md、SQLite+FTS5 会话档案与 Skills，以及写入/召回时机的工程实现。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/user-md-vs-memory-md',
    title: {
      'en-US': 'Why USER.md and MEMORY.md Cannot Be Merged',
      'zh-CN': 'USER.md 与 MEMORY.md 为什么不能合并？',
    },
    file: 'hermes-agent/03-user-md-vs-memory-md.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Three hard constraints — capacity, loading strategy, and update semantics — explain why Hermes Agent keeps long-term memory in two separate notes instead of a single merged file.',
      'zh-CN': '从容量、加载策略、更新语义三条硬约束，解释 Hermes Agent 为什么把长期记忆拆成 USER.md 与 MEMORY.md 两份笔记，而不是合并成一份。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/hermes-memory-curation',
    title: {
      'en-US': 'Hermes Agent Long-Term Memory Curation: Four Iron Rules for "Few but Precise"',
      'zh-CN': 'Hermes Agent 的长期记忆治理：少而准的四条铁律',
    },
    file: 'hermes-agent/04-hermes-memory-curation.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Break down the four iron rules — bounded, frozen, transparent, self-consolidating — that keep Hermes Agent long-term memory precise rather than bloated.',
      'zh-CN': '解析 Hermes Agent 长期记忆治理的四条铁律：有界、冻结、透明、自我整合，以及它们如何保证记忆"少而准"而不是"多而乱"。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/memory-vs-skill',
    title: {
      'en-US': 'Memory vs Skill: Declarative Memory and Procedural Memory',
      'zh-CN': 'Memory vs Skill：陈述性记忆与程序性记忆',
    },
    file: 'hermes-agent/05-memory-vs-skill.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Grounded in declarative vs procedural memory from cognitive science, explain why Hermes Agent splits long-term memory into Memory and Skill, and how they differ in trigger, form, and evolution speed.',
      'zh-CN': '从认知心理学的陈述性记忆与程序性记忆出发，解释 Hermes Agent 为什么把长期记忆拆成 Memory 与 Skill 两条腿，以及两者的触发方式、表达形式、演化速度差异。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/model-vs-agent-layer',
    title: {
      'en-US': 'Can You Replace Hermes Agent\'s Brain? Model Layer vs Agent Layer',
      'zh-CN': 'Hermes Agent 的“大脑”可以替换吗？模型层与 Agent 层如何分工',
    },
    file: 'hermes-agent/06-model-vs-agent-layer.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Learn which responsibilities belong to the model and which stay with the Agent, including identity, memory, tools, channels, and scheduled work.',
      'zh-CN': '理解模型与 Agent 的职责边界，以及身份、记忆、工具、通道和自动任务为什么不随模型切换而消失。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/message-gateway',
    title: {
      'en-US': 'How Can One Agent Appear Across Multiple Messaging Apps?',
      'zh-CN': '一个 Agent 如何同时出现在多个聊天软件里？拆解消息网关机制',
    },
    file: 'hermes-agent/07-message-gateway.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'See how a messaging gateway turns channel-specific events into a shared Agent conversation while preserving routing, context, and replies.',
      'zh-CN': '拆解消息网关如何把不同聊天软件的事件收敛到同一个 Agent，同时保留路由、上下文和回复出口。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/automation-scheduling',
    title: {
      'en-US': 'How Does Hermes Agent Reach You on Schedule?',
      'zh-CN': 'Hermes Agent 如何按时主动找你？拆解自动化调度与定时任务机制',
    },
    file: 'hermes-agent/08-automation-scheduling.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Understand the event, schedule, execution, and delivery layers that let an Agent proactively complete recurring work.',
      'zh-CN': '理解事件、调度、执行和投递如何协同，让 Agent 按计划主动完成重复工作。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/model-switching-memory',
    title: {
      'en-US': 'Will Switching Models Make an Agent Forget?',
      'zh-CN': '切换模型会让 Agent“失忆”吗？模型、人格与记忆的解耦设计',
    },
    file: 'hermes-agent/09-model-switching-memory.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Learn how a decoupled model, persona, and memory design lets an Agent change its inference engine without losing its long-term context.',
      'zh-CN': '理解模型、人格与记忆的解耦设计如何让 Agent 更换推理引擎后仍保留长期上下文。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/persona-user-memory',
    title: {
      'en-US': 'Where Does Hermes Agent\'s Personality Come From?',
      'zh-CN': 'Hermes Agent 的性格从哪里来？Persona、用户偏好与长期记忆如何共同作用',
    },
    file: 'hermes-agent/10-persona-user-memory.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Explore how persona rules, user preferences, and long-term memory work together to produce a stable but adaptive Agent personality.',
      'zh-CN': '探索 Persona 规则、用户偏好和长期记忆如何共同形成稳定且会适应的 Agent 性格。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/workspace-context-storage',
    title: {
      'en-US': 'Where Does Hermes Agent Put Files?',
      'zh-CN': 'Hermes Agent 把文件放在哪里？工作目录、上下文文件与存储机制',
    },
    file: 'hermes-agent/11-workspace-context-storage.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'Learn the distinct roles of a working directory, context files, and persistent storage when an Agent creates and reuses work.',
      'zh-CN': '了解工作目录、上下文文件和持久化存储的不同职责，以及 Agent 如何创建和复用工作成果。',
    },
    hideDescription: true,
  },
  {
    slug: 'hermes-agent/skills-self-improvement',
    title: {
      'en-US': 'Why Does an Agent Get Better with Use?',
      'zh-CN': 'Agent 为什么会越用越顺手？技能沉淀、自我改进与复用机制',
    },
    file: 'hermes-agent/12-skills-self-improvement.md',
    group: { 'en-US': 'Hermes Agent Deep Dive', 'zh-CN': 'Hermes Agent 解读' },
    description: {
      'en-US': 'See how reusable Skills turn successful work patterns into durable instructions that make future Agent tasks more reliable.',
      'zh-CN': '了解可复用 Skill 如何把成功的工作模式沉淀为长期指令，让 Agent 的后续任务更可靠。',
    },
    hideDescription: true,
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
    hideDescription: true,
  },
];

const ES_DOC_METADATA = {
  overview: {
    title: 'Qué es LightVela',
    description: 'LightVela es un compañero Hermes Agent alojado en la nube que mantiene activas tus conversaciones y automatizaciones.',
  },
  quickstart: {
    title: 'Inicio rápido',
    description: 'Configura tu primera conversación con LightVela en pocos minutos.',
  },
  'core-concepts': {
    title: 'Conceptos básicos',
    description: 'Comprende Hermes, los modelos, los canales, las Skills y las automatizaciones de LightVela.',
  },
  'who-is-lightvela-for': {
    title: '¿Para quién es LightVela?',
    description: 'Descubre para quién está pensado LightVela, incluido quien busca un compañero de IA personal en la nube sin administrar servidores ni infraestructura.',
  },
  plans: {
    title: 'Planes',
    description: 'Compara los planes de LightVela, los recursos aislados en la nube, los créditos de IA mensuales y las reglas y pasos de reembolso por correo electrónico.',
  },
  'announcements/public-beta': {
    title: 'Anuncio de la versión de pago de LightVela',
    description: 'LightVela prevé iniciar la beta pública y la facturación el 18 de agosto de 2026, hora de Singapur, con beneficios específicos para usuarios actuales y nuevos.',
  },
  credits: {
    title: 'Créditos',
    description: 'Aprende cómo se asignan y consumen los créditos de modelos de LightVela según el uso de tokens y cómo se relacionan con los planes y modelos.',
  },
  'create-first-hermes': {
    title: 'Cómo activar tu primera instancia de Hermes',
    description: 'Activa tu primera instancia de Hermes con Google o GitHub, un plan disponible, aprovisionamiento automático en la nube y un canal de mensajería internacional.',
  },
  'configuration/index': {
    title: 'Resumen de configuración',
    description: 'Revisa el flujo de configuración de la consola de LightVela.',
  },
  'configuration/model': {
    title: 'Configurar modelos',
    description: 'Conecta y administra los modelos de lenguaje que utiliza Hermes.',
  },
  'configuration/channel-telegram': {
    title: 'Canal de Telegram',
    description: 'Conecta Telegram con tu Hermes Agent.',
  },
  'configuration/channel-whatsapp': {
    title: 'Canal de WhatsApp',
    description: 'Conecta WhatsApp con tu Hermes Agent.',
  },
  'configuration/channel-discord': {
    title: 'Canal de Discord',
    description: 'Conecta Discord con tu Hermes Agent.',
  },
  'configuration/channel-slack': {
    title: 'Canal de Slack',
    description: 'Conecta Slack con tu Hermes Agent mediante un Slack Bot Token y un App Token.',
  },
  'configuration/channel-wechat': {
    title: 'Canal de WeChat',
    description: 'Conecta WeChat con tu Hermes Agent.',
  },
  'configuration/channel-qq': {
    title: 'Canal de QQ',
    description: 'Conecta QQ con tu Hermes Agent.',
  },
  'configuration/channel-wecom': {
    title: 'Canal de WeCom',
    description: 'Conecta WeCom con tu Hermes Agent.',
  },
  'configuration/channel-feishu': {
    title: 'Canal de Lark',
    description: 'Conecta Lark con tu Hermes Agent.',
  },
  'configuration/skill': {
    title: 'Configurar Skills',
    description: 'Instala Skills para ampliar las capacidades de Hermes.',
  },
  'configuration/personality': {
    title: 'Personalidad',
    description: 'Elige y aplica una personalidad Soul para definir el rol, la voz, las prioridades y los límites de comportamiento de Hermes Agent.',
  },
  'configuration/memory': {
    title: 'Gestión de la memoria',
    description: 'Aprende cómo Hermes almacena y administra recuerdos a largo plazo y perfiles de usuario entre dispositivos y canales de mensajería.',
  },
  'configuration/automation': {
    title: 'Automatizaciones',
    description: 'Crea automatizaciones programadas para tu Hermes Agent.',
  },
  'configuration/files': {
    title: 'Almacenamiento en la nube',
    description: 'Organiza los archivos que tu Agent puede utilizar como contexto de trabajo en LightVela.',
  },
  'configuration/agent-chat': {
    title: 'Chat del Agent',
    description: 'Habla con Hermes y revisa el comportamiento de la conversación.',
  },
  'configuration/diagnostics': {
    title: 'Diagnóstico',
    description: 'Usa el centro de diagnóstico para revisar el estado del Agent, los canales y la configuración esencial.',
  },
  'configuration/advanced-settings': {
    title: 'Configuración avanzada',
    description: 'Revisa y ajusta la seguridad, la memoria y la gestión del contexto de Hermes Agent.',
  },
  'configuration/multiple-models': {
    title: 'Cambio de modelo',
    description: 'Administra varias configuraciones de modelos y selecciona la adecuada para cada necesidad del Agent.',
  },
  'configuration/deepseek-harness': {
    title: 'DeepSeek Harness',
    description: 'Instala y administra DeepSeek Harness como un entorno Labs independiente que funciona junto a Hermes Agent en LightVela.',
  },
  'use-cases/personal-ai-assistant': {
    title: 'Cómo crear un asistente personal de IA con LightVela',
    description: 'Usa LightVela como asistente personal de IA para recordatorios, resúmenes y conversaciones cotidianas.',
  },
  'use-cases/chinese-messaging-channels': {
    title: 'Cómo conectar un Agent de IA a plataformas de mensajería',
    description: 'Aprende a conectar un Agent con las aplicaciones de mensajería compatibles del sitio internacional.',
  },
  'use-cases/telegram-persona-agent': {
    title: 'Cómo configurar una personalidad propia para Hermes Agent en Telegram',
    description: 'Crea un Agent de Telegram con un rol, una voz y una memoria coherentes.',
  },
  'use-cases/whatsapp-persona-agent': {
    title: 'Cómo configurar una personalidad propia para Hermes Agent en WhatsApp',
    description: 'Usa Hermes Agent en WhatsApp con una personalidad estable para conversaciones personales o de servicio.',
  },
  'use-cases/im-agent-persona-soul-md': {
    title: 'Cómo definir el rol, la personalidad y la voz de un Agent de mensajería con SOUL.md',
    description: 'Aprende a estructurar la personalidad del Agent para que responda de forma coherente en las aplicaciones de mensajería.',
  },
  'use-cases/im-agent-skill-scenarios': {
    title: 'Cómo convertir un Agent de mensajería en asistente de servicio, comunidad o compañía mediante Skills',
    description: 'Usa Skills para ampliar el Agent en escenarios de atención al cliente, comunidad y acompañamiento personal.',
  },
  'use-cases/multi-channel-personality-memory': {
    title: 'Cómo usar un solo Agent en Telegram y WhatsApp con la misma personalidad y memoria',
    description: 'Mantén coherentes la personalidad y la memoria del Agent cuando lo utilizas en varios canales.',
  },
  'use-cases/telegram-group-community-assistant': {
    title: 'Cómo configurar un asistente de comunidad con IA para un grupo de Telegram',
    description: 'Diseña mensajes de bienvenida, preguntas frecuentes, resúmenes y recordatorios con límites claros para el uso en grupos.',
  },
  'use-cases/whatsapp-24-7-customer-service': {
    title: 'Cómo configurar atención al cliente con IA 24/7 en WhatsApp',
    description: 'Configura personalidad, conocimiento, Skills y automatizaciones para un flujo de atención al cliente en WhatsApp.',
  },
  'use-cases/lifelike-im-agent-rhythm-social-memory': {
    title: 'Cómo diseñar un Agent de mensajería más natural',
    description: 'Ajusta el ritmo de conversación, las normas del grupo y la memoria social a largo plazo para lograr interacciones más naturales.',
  },
  'use-cases/telegram-whatsapp-safety-boundaries': {
    title: 'Cómo diseñar límites de seguridad para Agents de Telegram y WhatsApp',
    description: 'Define autorización, reglas de grupo y protección de acciones sensibles para Agents en aplicaciones de mensajería.',
  },
  'use-cases/daily-summary': {
    title: 'Cómo crear resúmenes diarios con Hermes Agent',
    description: 'Genera automáticamente resúmenes diarios de la información que quieras supervisar.',
  },
  'use-cases/hermes-agent-24-7': {
    title: 'Cómo mantener Hermes Agent disponible 24/7',
    description: 'Descubre cómo Hermes Agent permanece disponible en la nube sin depender de un dispositivo local.',
  },
  'use-cases/memory-and-knowledge': {
    title: 'Cómo gestionar la memoria a largo plazo y el conocimiento personal con un Agent',
    description: 'Usa la memoria y el conocimiento del Agent para aportar más contexto a las conversaciones futuras.',
  },
  'use-cases/discord-community-agent': {
    title: 'LightVela para Discord: un Agent de IA al servicio de tu canal',
    description: 'Configura un Agent compartido de Discord para preguntas de la comunidad, incorporación y apoyo a eventos.',
  },
  'use-cases/discord-event-agent': {
    title: 'Potencia tu bot de eventos de Discord con capacidades de Agent de IA',
    description: 'Usa un Agent de Discord para responder preguntas, enviar recordatorios y mantener coherentes las operaciones de un evento.',
  },
  'compare/lightvela-vs-localhost-ai-agent': {
    title: 'LightVela frente a un Agent autoalojado: ¿cuál te conviene?',
    description: 'Compara LightVela con un Agent ejecutado en un dispositivo o servidor propio.',
  },
  'compare/lightvela-vs-hostinger': {
    title: 'LightVela frente a Hostinger: ¿cuál conviene para alojar un Agent?',
    description: 'Compara LightVela con un VPS general cuando necesitas mantener un Agent siempre disponible.',
  },
  'compare/lightvela-vs-manus': {
    title: 'LightVela frente a Manus: ¿cuál conviene para tu Agent de IA?',
    description: 'Compara los enfoques de LightVela y Manus para las necesidades de un Agent personal en la nube.',
  },
  'compare/lightvela-vs-chatgpt': {
    title: 'LightVela frente a ChatGPT: ¿cuál conviene para crear un asistente personal de IA?',
    description: 'Compara las experiencias de LightVela y ChatGPT al crear un asistente personal de IA siempre disponible.',
  },
  'compare/lightvela-vs-genspark': {
    title: 'LightVela frente a Genspark: ¿cuál conviene para alojar un Agent de IA?',
    description: 'Compara LightVela y Genspark desde la perspectiva de un Agent personal que se ejecuta en la nube.',
  },
  'compare/lightvela-vs-grok-bot': {
    title: 'LightVela frente a Grok Bot: ¿cuál es mejor para ejecutar tu AI Agent personal?',
    description: 'Compara LightVela y Grok Bot para ejecutar un AI Agent personal, desde las rutinas persistentes y la mensajería hasta los ordenadores cloud y el trabajo delegado.',
  },
  'compare/lightvela-vs-mira': {
    title: 'LightVela frente a Mira: ¿cuál es mejor para ejecutar tu AI Agent personal?',
    description: 'Compara LightVela y Mira para ejecutar un AI Agent personal, desde las rutinas persistentes y los canales de mensajería hasta la colaboración centrada en Telegram y las acciones desde el chat.',
  },
  'compare/lightvela-vs-viktor': {
    title: 'LightVela frente a Viktor.com: ¿cuál es mejor para ejecutar tu AI Agent personal?',
    description: 'Compara LightVela y Viktor.com para ejecutar un AI Agent personal, desde la asistencia personal persistente hasta los flujos de equipo entre herramientas empresariales.',
  },
  'compare/lightvela-vs-today-ai': {
    title: 'LightVela frente a Today.AI: ¿cuál es mejor para un asistente personal de IA siempre disponible?',
    description: 'Compara LightVela y Today.AI para un asistente personal de IA siempre disponible, desde el alojamiento explícito del Agent y las Automatizaciones hasta el contexto personal proactivo entre dispositivos.',
  },
  'hermes-agent/hermes-vs-openclaw': {
    title: 'Hermes Agent frente a OpenClaw: diferencias fundamentales entre dos Agents de código abierto',
    description: 'Compara Hermes Agent y OpenClaw en memoria a largo plazo, ecosistemas de Skills e integración multiplataforma para identificar qué Agent encaja con tu caso de uso.',
  },
  'hermes-agent/why-hermes-remembers-you': {
    title: '¿Cómo te recuerda Hermes Agent?',
    description: 'Descubre el sistema de memoria a largo plazo de cuatro capas de Hermes Agent: USER.md, MEMORY.md, el archivo de conversaciones SQLite+FTS5 y las Skills.',
  },
  'hermes-agent/user-md-vs-memory-md': {
    title: 'Por qué USER.md y MEMORY.md no pueden combinarse',
    description: 'Tres restricciones, capacidad, estrategia de carga y semántica de actualización, explican por qué Hermes Agent separa la memoria a largo plazo en dos notas.',
  },
  'hermes-agent/hermes-memory-curation': {
    title: 'Curación de la memoria a largo plazo de Hermes Agent: cuatro reglas para conservar poco y preciso',
    description: 'Analiza las reglas de memoria acotada, estable, transparente y autoconsolidada que evitan que la memoria a largo plazo se vuelva imprecisa.',
  },
  'hermes-agent/memory-vs-skill': {
    title: 'Memoria frente a Skill: memoria declarativa y procedimental',
    description: 'Comprende por qué Hermes Agent divide la memoria a largo plazo entre Memory y Skill y cómo difieren en activación, forma y evolución.',
  },
  'hermes-agent/model-vs-agent-layer': {
    title: '¿Puedes sustituir el cerebro de Hermes Agent? Capa de modelo frente a capa de Agent',
    description: 'Descubre qué responsabilidades pertenecen al modelo y cuáles permanecen en el Agent, como identidad, memoria, herramientas, canales y tareas programadas.',
  },
  'hermes-agent/message-gateway': {
    title: '¿Cómo puede un Agent aparecer en varias aplicaciones de mensajería?',
    description: 'Observa cómo una pasarela de mensajería convierte eventos específicos de cada canal en una conversación compartida con el Agent.',
  },
  'hermes-agent/automation-scheduling': {
    title: '¿Cómo se pone en contacto Hermes Agent contigo según un horario?',
    description: 'Comprende las capas de evento, programación, ejecución y entrega que permiten al Agent completar trabajo recurrente de forma proactiva.',
  },
  'hermes-agent/model-switching-memory': {
    title: '¿Cambiar de modelo hace que un Agent olvide?',
    description: 'Aprende cómo desacoplar modelo, personalidad y memoria permite cambiar el motor de inferencia sin perder el contexto a largo plazo.',
  },
  'hermes-agent/persona-user-memory': {
    title: '¿De dónde proviene la personalidad de Hermes Agent?',
    description: 'Explora cómo las reglas de personalidad, las preferencias del usuario y la memoria a largo plazo producen una personalidad estable y adaptable.',
  },
  'hermes-agent/workspace-context-storage': {
    title: '¿Dónde guarda los archivos Hermes Agent?',
    description: 'Conoce las funciones distintas del directorio de trabajo, los archivos de contexto y el almacenamiento persistente cuando un Agent crea y reutiliza trabajo.',
  },
  'hermes-agent/skills-self-improvement': {
    title: '¿Por qué un Agent mejora con el uso?',
    description: 'Descubre cómo las Skills reutilizables convierten patrones de trabajo eficaces en instrucciones duraderas para hacer más fiables las tareas futuras.',
  },
  'contact-us': {
    title: 'Contacto',
    description: 'Únete a la comunidad beta de LightVela, habla directamente con el equipo de producto y comparte preguntas, sugerencias y experiencias reales.',
  },
};

const ID_GROUP_LABELS = {
  'Getting Started': 'Mulai',
  'Plans & Activation': 'Paket & Aktivasi',
  'Features & Configuration': 'Fitur & Konfigurasi',
  'Use Cases': 'Skenario Penggunaan',
  'Compare & Choose': 'Perbandingan & Pilihan',
  'Hermes Agent Deep Dive': 'Mengenal Hermes Agent',
  'Troubleshooting': 'Pemecahan Masalah',
  'Advanced': 'Lanjutan',
  'Support': 'Dukungan',
};

const ID_DOC_METADATA = {
  overview: {
    title: 'Apa Itu LightVela',
    description: 'LightVela adalah Hermes Agent berbasis cloud yang membuat percakapan, memori, dan otomasi tetap berjalan online 24/7.',
  },
  quickstart: {
    title: 'Panduan Cepat',
    description: 'Siapkan percakapan LightVela pertama Anda dalam beberapa menit.',
  },
  'who-is-lightvela-for': {
    title: 'Untuk Siapa LightVela?',
    description: 'Ketahui siapa yang paling cocok menggunakan LightVela, dari pengguna non-teknis hingga pengguna yang membutuhkan Agent pribadi yang selalu online.',
  },
  'core-concepts': {
    title: 'Konsep Inti',
    description: 'Pahami Hermes Agent, model, kanal, Skill, dan otomasi di LightVela.',
  },
  plans: {
    title: 'Paket',
    description: 'Bandingkan paket LightVela, sumber daya cloud terisolasi, kredit model bulanan, dan alur aktivasi internasional saat ini.',
  },
  'create-first-hermes': {
    title: 'Cara Mengaktifkan Instans Hermes Pertama',
    description: 'Aktifkan instans Hermes pertama Anda dengan Google atau GitHub, paket yang tersedia, provisioning cloud otomatis, dan kanal chat internasional.',
  },
  'configuration/index': {
    title: 'Ringkasan Konfigurasi',
    description: 'Pelajari alur konfigurasi konsol LightVela.',
  },
  'configuration/model': {
    title: 'Konfigurasi Model',
    description: 'Atur model bahasa untuk Hermes Agent, termasuk penyedia model, kredensial API, dan pemeriksaan koneksi.',
  },
  'configuration/channel-telegram': {
    title: 'Kanal Telegram',
    description: 'Hubungkan Hermes Agent ke Telegram dengan Bot Token dan pengaturan kanal yang benar.',
  },
  'configuration/channel-whatsapp': {
    title: 'Kanal WhatsApp',
    description: 'Hubungkan Hermes Agent ke WhatsApp untuk percakapan pribadi, notifikasi, dan alur kerja chat.',
  },
  'configuration/channel-discord': {
    title: 'Kanal Discord',
    description: 'Konfigurasikan Discord agar Hermes Agent dapat menerima pesan dan mengirim balasan di ruang yang didukung.',
  },
  'configuration/channel-slack': {
    title: 'Kanal Slack',
    description: 'Siapkan token Slack dan izin yang diperlukan agar Hermes Agent dapat terhubung ke workspace.',
  },
  'configuration/channel-wechat': {
    title: 'Kanal WeChat',
    description: 'Hubungkan Hermes Agent ke WeChat dan pastikan percakapan dapat dijadikan kanal notifikasi.',
  },
  'configuration/channel-qq': {
    title: 'Kanal QQ',
    description: 'Konfigurasikan QQ Open Platform dan hubungkan kredensial bot ke LightVela.',
  },
  'configuration/channel-wecom': {
    title: 'Kanal WeCom',
    description: 'Siapkan WeCom sebagai kanal percakapan dan notifikasi untuk Hermes Agent.',
  },
  'configuration/channel-feishu': {
    title: 'Kanal Lark',
    description: 'Hubungkan Hermes Agent ke Lark melalui aplikasi bot dan kredensial yang sesuai.',
  },
  'configuration/skill': {
    title: 'Konfigurasi Skill',
    description: 'Pelajari cara memasang, melihat, dan mengelola Skill yang dapat digunakan Hermes Agent.',
  },
  'configuration/personality': {
    title: 'Soul',
    description: 'Pilih, unggah, dan terapkan Soul untuk menentukan peran, gaya komunikasi, prioritas, dan batas perilaku Hermes Agent.',
  },
  'configuration/memory': {
    title: 'Pengelolaan Memori',
    description: 'Lihat cara Hermes Agent menyimpan memori jangka panjang dan bagaimana kapasitasnya ditampilkan.',
  },
  'configuration/automation': {
    title: 'Otomasi',
    description: 'Atur tugas otomatis agar Hermes Agent dapat menjalankan rutinitas terjadwal di cloud.',
  },
  'configuration/files': {
    title: 'File',
    description: 'Kelola file yang dapat digunakan Agent sebagai konteks kerja di LightVela.',
  },
  'configuration/agent-chat': {
    title: 'Chat Agent',
    description: 'Pahami cara berbicara langsung dengan Hermes Agent dan memeriksa responsnya.',
  },
  'configuration/diagnostics': {
    title: 'Diagnostik',
    description: 'Gunakan pusat diagnostik untuk memeriksa status Agent, kanal, dan konfigurasi penting.',
  },
  'configuration/advanced-settings': {
    title: 'Pengaturan Lanjutan',
    description: 'Tinjau dan sesuaikan pengaturan keamanan, memori, serta pengelolaan konteks Hermes Agent.',
  },
  'configuration/multiple-models': {
    title: 'Beberapa Model',
    description: 'Kelola beberapa konfigurasi model dan pilih model yang sesuai untuk kebutuhan Agent.',
  },
  'configuration/deepseek-harness': {
    title: 'DeepSeek Harness',
    description: 'Instal dan kelola DeepSeek Harness sebagai lingkungan Labs terpisah yang berjalan berdampingan dengan Hermes Agent di LightVela.',
  },
  credits: {
    title: 'Kredit',
    description: 'Pelajari cara kredit model LightVela dialokasikan, digunakan berdasarkan token, dan terkait dengan paket serta model.',
  },
  'announcements/public-beta': {
    title: 'Pengumuman Versi Berbayar LightVela',
    description: 'LightVela berencana masuk beta publik dan mulai menagih pada 18 Agustus 2026 (Waktu Singapura).',
  },
  'use-cases/personal-ai-assistant': {
    title: 'Membangun Asisten AI Pribadi dengan LightVela',
    description: 'Gunakan LightVela sebagai asisten AI pribadi untuk pengingat, ringkasan, dan percakapan harian.',
  },
  'use-cases/chinese-messaging-channels': {
    title: 'Menghubungkan AI Agent ke Platform Chat',
    description: 'Pelajari cara menghubungkan Agent ke aplikasi chat yang didukung di situs internasional.',
  },
  'use-cases/telegram-persona-agent': {
    title: 'Mengatur Kepribadian Hermes Agent di Telegram',
    description: 'Bangun Agent Telegram dengan peran, gaya bicara, dan memori yang konsisten.',
  },
  'use-cases/whatsapp-persona-agent': {
    title: 'Mengatur Kepribadian Hermes Agent di WhatsApp',
    description: 'Gunakan Hermes Agent di WhatsApp dengan persona yang stabil untuk percakapan pribadi atau layanan.',
  },
  'use-cases/im-agent-persona-soul-md': {
    title: 'Menentukan Peran, Kepribadian, dan Suara IM Agent',
    description: 'Pahami cara menyusun persona Agent agar responsnya terasa konsisten di aplikasi chat.',
  },
  'use-cases/im-agent-skill-scenarios': {
    title: 'Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping',
    description: 'Gunakan Skill untuk memperluas kemampuan Agent dalam skenario layanan pelanggan, komunitas, dan pendamping pribadi.',
  },
  'use-cases/multi-channel-personality-memory': {
    title: 'Satu Agent di Telegram dan WhatsApp dengan Persona dan Memori yang Sama',
    description: 'Pelajari cara menjaga kepribadian dan memori Agent tetap konsisten saat digunakan di beberapa kanal.',
  },
  'use-cases/telegram-group-community-assistant': {
    title: 'Cara Menggunakan Asisten Komunitas AI Grup Telegram: Tanya Jawab, Ringkasan, dan Pengingat',
    description: 'Siapkan pesan grup Telegram dengan Group Privacy, @mention, tanya jawab, ringkasan, dan draf pengingat.',
  },
  'use-cases/whatsapp-24-7-customer-service': {
    title: 'Layanan Pelanggan AI 24/7 di WhatsApp',
    description: 'Siapkan persona, pengetahuan, Skill, dan otomasi untuk alur layanan pelanggan WhatsApp.',
  },
  'use-cases/lifelike-im-agent-rhythm-social-memory': {
    title: 'Merancang IM Agent yang Lebih Natural',
    description: 'Atur ritme percakapan, norma grup, dan memori sosial jangka panjang agar Agent terasa lebih manusiawi.',
  },
  'use-cases/telegram-whatsapp-safety-boundaries': {
    title: 'Batas Keamanan untuk Agent Telegram dan WhatsApp',
    description: 'Rancang otorisasi, aturan grup, dan perlindungan tindakan sensitif untuk Agent di aplikasi chat.',
  },
  'use-cases/daily-summary': {
    title: 'Membuat Ringkasan Harian dengan Hermes Agent',
    description: 'Jalankan ringkasan harian otomatis untuk informasi yang ingin Anda pantau.',
  },
  'use-cases/hermes-agent-24-7': {
    title: 'Menjaga Hermes Agent Online 24/7',
    description: 'Pahami cara Hermes Agent tetap tersedia di cloud tanpa bergantung pada perangkat lokal.',
  },
  'use-cases/memory-and-knowledge': {
    title: 'Mengelola Memori Jangka Panjang dan Pengetahuan Pribadi',
    description: 'Gunakan memori dan pengetahuan Agent agar percakapan berikutnya lebih kontekstual.',
  },
  'compare/lightvela-vs-localhost-ai-agent': {
    title: 'LightVela vs Agent yang Dihosting Sendiri: Mana yang Lebih Sesuai?',
    description: 'Bandingkan LightVela dengan Agent yang dijalankan sendiri di perangkat atau server pribadi.',
  },
  'compare/lightvela-vs-hostinger': {
    title: 'LightVela vs Hostinger: Mana yang Lebih Sesuai untuk Hosting Agent?',
    description: 'Bandingkan LightVela dengan VPS umum saat ingin menjalankan Agent yang selalu online.',
  },
  'compare/lightvela-vs-manus': {
    title: 'LightVela vs Manus: Mana yang Lebih Sesuai untuk AI Agent?',
    description: 'Bandingkan pendekatan LightVela dan Manus untuk kebutuhan Agent pribadi berbasis cloud.',
  },
  'compare/lightvela-vs-chatgpt': {
    title: 'LightVela vs ChatGPT: Mana yang Lebih Sesuai untuk Asisten AI Pribadi?',
    description: 'Bandingkan pengalaman LightVela dan ChatGPT saat membangun asisten AI pribadi yang selalu tersedia.',
  },
  'compare/lightvela-vs-genspark': {
    title: 'LightVela vs Genspark: Mana yang Lebih Sesuai untuk Hosting AI Agent?',
    description: 'Bandingkan LightVela dan Genspark dari sudut pandang Agent pribadi yang berjalan di cloud.',
  },
  'compare/lightvela-vs-grok-bot': {
    title: 'LightVela vs Grok Bot: Mana yang lebih tepat untuk menjalankan AI Agent pribadi?',
    description: 'Bandingkan LightVela dan Grok Bot untuk menjalankan AI Agent pribadi, mulai dari rutinitas persisten dan akses pesan hingga komputer cloud dan pekerjaan terdelegasi.',
  },
  'compare/lightvela-vs-mira': {
    title: 'LightVela vs Mira: Mana yang lebih tepat untuk menjalankan AI Agent pribadi?',
    description: 'Bandingkan LightVela dan Mira untuk menjalankan AI Agent pribadi, mulai dari rutinitas persisten dan kanal pesan hingga kolaborasi yang berpusat pada Telegram dan tindakan melalui chat.',
  },
  'compare/lightvela-vs-viktor': {
    title: 'LightVela vs Viktor.com: Mana yang lebih tepat untuk AI Agent pribadi?',
    description: 'Bandingkan LightVela dan Viktor.com untuk menjalankan AI Agent pribadi, mulai dari bantuan pribadi yang persisten hingga alur kerja tim lintas tools bisnis.',
  },
  'compare/lightvela-vs-today-ai': {
    title: 'LightVela vs Today.AI: Mana yang lebih tepat untuk asisten AI pribadi yang selalu tersedia?',
    description: 'Bandingkan LightVela dan Today.AI untuk asisten AI pribadi yang selalu tersedia, mulai dari hosting Agent dan Automations yang jelas hingga konteks pribadi proaktif lintas perangkat.',
  },
  'hermes-agent/hermes-vs-openclaw': {
    title: 'Hermes Agent vs OpenClaw',
    description: 'Pahami perbedaan Hermes Agent dan OpenClaw dari sisi tujuan, runtime, dan pengalaman pengguna.',
  },
  'hermes-agent/why-hermes-remembers-you': {
    title: 'Bagaimana Hermes Agent Mengingat Anda?',
    description: 'Pelajari mekanisme memori Hermes Agent dan bagaimana konteks digunakan dalam percakapan berikutnya.',
  },
  'hermes-agent/user-md-vs-memory-md': {
    title: 'USER.md vs MEMORY.md',
    description: 'Pahami perbedaan memori profil pengguna dan catatan memori jangka panjang dalam Hermes Agent.',
  },
  'hermes-agent/hermes-memory-curation': {
    title: 'Kurasi Memori Jangka Panjang Hermes Agent',
    description: 'Pelajari prinsip kurasi memori agar Agent menyimpan konteks yang berguna dan tetap terkendali.',
  },
  'hermes-agent/memory-vs-skill': {
    title: 'Memori vs Skill',
    description: 'Bedakan memori deklaratif dan kemampuan prosedural yang digunakan Hermes Agent.',
  },
  'hermes-agent/model-vs-agent-layer': {
    title: 'Model vs Lapisan Agent',
    description: 'Pahami peran model bahasa dan lapisan Agent dalam pengalaman Hermes.',
  },
  'hermes-agent/message-gateway': {
    title: 'Satu Agent di Banyak Aplikasi Chat',
    description: 'Pelajari bagaimana satu Agent dapat muncul di beberapa kanal percakapan.',
  },
  'hermes-agent/automation-scheduling': {
    title: 'Bagaimana Hermes Agent Menjangkau Anda Sesuai Jadwal?',
    description: 'Pahami alur penjadwalan otomasi dan pengiriman notifikasi oleh Hermes Agent.',
  },
  'hermes-agent/model-switching-memory': {
    title: 'Apakah Ganti Model Membuat Agent Lupa?',
    description: 'Ketahui hubungan antara pilihan model dan memori Agent yang tersimpan di LightVela.',
  },
  'hermes-agent/persona-user-memory': {
    title: 'Persona dan Memori Pengguna',
    description: 'Pelajari mengapa karakter Agent yang sama dapat merespons berbeda untuk pengguna yang berbeda.',
  },
  'hermes-agent/workspace-context-storage': {
    title: 'Di Mana Hermes Agent Menyimpan File?',
    description: 'Pahami cara Agent menggunakan ruang kerja dan penyimpanan konteks.',
  },
  'hermes-agent/skills-self-improvement': {
    title: 'Skill dan Peningkatan Diri Agent',
    description: 'Pelajari bagaimana Skill membantu Agent menjalankan pola kerja yang dapat digunakan ulang.',
  },
  'contact-us': {
    title: 'Hubungi Kami',
    description: 'Bergabunglah dengan komunitas beta LightVela, bicara langsung dengan tim produk, dan kirimkan masukan dari penggunaan nyata.',
  },
};

for (const doc of globalDocs) {
  if (doc.group && typeof doc.group === 'object') {
    const englishGroup = doc.group[LOCALES.EN_US];
    const esGroup = ES_GROUP_LABELS[englishGroup];
    if (!esGroup) throw new Error(`missing Spanish docs group label: ${englishGroup}`);
    doc.group[LOCALES.ES] = esGroup;
  }

  const esMetadata = ES_DOC_METADATA[doc.slug];
  if (!esMetadata) throw new Error(`missing Spanish docs metadata: ${doc.slug}`);
  doc.title[LOCALES.ES] = esMetadata.title;
  doc.description[LOCALES.ES] = esMetadata.description;

  if (doc.group && typeof doc.group === 'object') {
    const englishGroup = doc.group[LOCALES.EN_US];
    const idGroup = ID_GROUP_LABELS[englishGroup];
    if (idGroup) doc.group[LOCALES.ID_ID] = idGroup;
  }

  const idMetadata = ID_DOC_METADATA[doc.slug];
  if (!idMetadata) continue;
  doc.title[LOCALES.ID_ID] = idMetadata.title;
  doc.description[LOCALES.ID_ID] = idMetadata.description;
}

const globalDocsForEnglish = globalDocs.filter(
  (doc) =>
    (existsSync(join(sourceRoot, 'en', doc.file)) ||
      existsSync(join(sourceRoot, 'global', doc.file))) &&
    !isHiddenFor(doc, LOCALES.EN_US),
);

const globalDocsForIndonesian = globalDocs.filter(
  (doc) =>
    existsSync(join(sourceRoot, 'id', doc.file)) &&
    !isHiddenFor(doc, LOCALES.ID_ID),
);

const globalDocsForSpanish = globalDocsForEnglish.filter((doc) =>
  existsSync(join(sourceRoot, 'es', doc.file)),
);

/** 判断 doc 是否对某 locale 隐藏（仅按 hiddenForLocales 白名单）。 */
function isHiddenFor(doc, locale) {
  return Array.isArray(doc.hiddenForLocales) && doc.hiddenForLocales.includes(locale);
}

/**
 * zh-SG / zh-Hant 共用的中文文档集合。
 * 部分英文源尚未沉淀中文正文，标注 `hiddenForLocales` 后在中文站不生成对应页面
 * （包括路由、meta.json 侧边栏与 route manifest），避免出现繁体标题 + 英文占位的效果。
 */
function globalDocsForChineseLocale(locale) {
  return globalDocs.filter(
    (doc) => existsSync(join(sourceRoot, 'global', doc.file)) && !isHiddenFor(doc, locale),
  );
}

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
    docs: globalDocsForChineseLocale(LOCALES.ZH_SG),
    title: 'LightVela 文档',
  },
  {
    // 繁體中文文檔：与 zh-sg 同源（global 简体），生成时逐条做简→繁转换。
    outputPrefix: URL_LANGS.ZH_HANT,
    sourcePrefix: 'global',
    locale: LOCALES.ZH_HANT,
    docs: globalDocsForChineseLocale(LOCALES.ZH_HANT),
    title: 'LightVela 文件',
    convertToTraditional: true,
  },
  {
    outputPrefix: URL_LANGS.ID_ID,
    sourcePrefix: 'id',
    fallbackSourcePrefixes: ['en', 'global'],
    locale: LOCALES.ID_ID,
    docs: globalDocsForIndonesian,
    title: 'Dokumentasi LightVela',
  },
  {
    outputPrefix: URL_LANGS.ES,
    sourcePrefix: 'es',
    locale: LOCALES.ES,
    docs: globalDocsForSpanish,
    title: 'Documentación de LightVela',
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

export function stripTitle(markdown, title, stripSourceHeading = false) {
  if (stripSourceHeading) {
    return markdown.replace(/^\uFEFF?[\t ]*(?:\n[\t ]*)*#(?!#)\s+[^\n]+\n+/, '').trim();
  }
  return markdown.replace(new RegExp(`^#\\s+${escapeRegExp(title)}\\s*\\n+`), '').trim();
}

function allDocsForLinks(outputPrefix) {
  let localeDocs;
  if (outputPrefix === URL_LANGS.ZH_SG) {
    localeDocs = globalDocsForChineseLocale(LOCALES.ZH_SG);
  } else if (outputPrefix === URL_LANGS.ZH_HANT) {
    localeDocs = globalDocsForChineseLocale(LOCALES.ZH_HANT);
  } else if (outputPrefix === URL_LANGS.ID_ID) {
    localeDocs = globalDocsForIndonesian;
  } else if (outputPrefix === URL_LANGS.ES) {
    localeDocs = globalDocsForSpanish;
  } else {
    localeDocs = globalDocsForEnglish;
  }
  return outputPrefix === URL_LANGS.ES ? localeDocs : [...cnDocs, ...localeDocs];
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
  if (![LOCALES.EN_US, LOCALES.ID_ID, LOCALES.ES].includes(locale) || /-en\.[^.]+$/.test(imageName)) return imageName;
  const candidate = imageName.replace(/(\.[^.]+)$/, '-en$1');
  return existsSync(join(sourceRoot, 'images', candidate)) ? candidate : imageName;
}

function splitHrefSuffix(href) {
  const queryIndex = href.indexOf('?');
  const fragmentIndex = href.indexOf('#');
  const indexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const suffixIndex = indexes.length > 0 ? Math.min(...indexes) : -1;
  return suffixIndex < 0
    ? { path: href, suffix: '' }
    : { path: href.slice(0, suffixIndex), suffix: href.slice(suffixIndex) };
}

function rewriteMarkdownLinkDestination(destination, currentDir, fileToHref, outputPrefix) {
  const destinationParts = destination.match(/^(\S+)([\s\S]*)$/);
  if (!destinationParts?.[1]) return destination;

  const href = destinationParts[1];
  const titleSuffix = destinationParts[2] ?? '';
  const { path: hrefPath, suffix } = splitHrefSuffix(href);

  if (/^\.?\.?\/.*\.md$/.test(hrefPath)) {
    const resolved = relative('.', join(currentDir, hrefPath)).replaceAll('\\', '/').replace(/^\.\//, '');
    const target = fileToHref.get(resolved);
    return target ? `${target}${suffix}${titleSuffix}` : destination;
  }

  if (outputPrefix !== URL_LANGS.ES) return destination;

  const docsPath = hrefPath.startsWith('https://lightvela.ai/')
    ? hrefPath.slice('https://lightvela.ai'.length)
    : hrefPath;
  if (docsPath !== '/docs' && !docsPath.startsWith('/docs/')) return destination;

  const slug = docsPath.slice('/docs'.length).replace(/^\//, '').replace(/\/$/, '');
  const spanishSlugs = new Set(globalDocsForEnglish.map((doc) => doc.slug.replace(/\/index$/, '')));
  if (slug && !spanishSlugs.has(slug)) return destination;
  return `/es/docs${slug ? `/${slug}` : ''}${suffix}${titleSuffix}`;
}

export function normalizeMarkdownLinks(markdown, currentFile, outputPrefix, locale) {
  const currentDir = dirname(currentFile);
  const fileToHref = fileToHrefFor(outputPrefix);
  return markdown
    .replace(/(!?\[[^\]]*]\()(?:(?:\.\.?\/)?images\/)([^)\s]+)([^)]*\))/g, (_match, prefix, imageName, suffix) => {
      return `${prefix}/docs-images/${localizedImageName(imageName, locale)}${suffix}`;
    })
    .replace(/(?<!!)(\[[^\]\n]+]\()([^)\n]+)(\))/g, (match, opening, destination, closing) => {
      const rewritten = rewriteMarkdownLinkDestination(destination, currentDir, fileToHref, outputPrefix);
      return rewritten === destination ? match : `${opening}${rewritten}${closing}`;
    });
}

function sourcePathFor(docSet, file) {
  const primary = join(sourceRoot, docSet.sourcePrefix, file);
  if (existsSync(primary)) return primary;
  if (docSet.fallbackSourcePrefix) {
    const fallback = join(sourceRoot, docSet.fallbackSourcePrefix, file);
    if (existsSync(fallback)) return fallback;
  }
  if (docSet.fallbackSourcePrefixes) {
    for (const prefix of docSet.fallbackSourcePrefixes) {
      const fallback = join(sourceRoot, prefix, file);
      if (existsSync(fallback)) return fallback;
    }
  }
  return primary;
}

function writeDoc(docSet, doc) {
  const convert = docSet.convertToTraditional ? convertTraditional : (value) => value;
  const rawTitle = textFor(doc.title, docSet.locale);
  const title = convert(rawTitle);
  const description = convert(textFor(doc.description, docSet.locale));
  const inputPath = sourcePathFor(docSet, doc.file);
  if (!existsSync(inputPath)) {
    throw new Error(`missing LightVela doc source: ${inputPath}`);
  }

  const raw = readFileSync(inputPath, 'utf8').replace(/\r\n/g, '\n');
  const body = convert(
    normalizeMarkdownLinks(
      stripTitle(raw, rawTitle, docSet.locale === LOCALES.ES),
      doc.file,
      docSet.outputPrefix,
      docSet.locale,
    ),
  );
  const sourcePath = relative(frontendRoot, inputPath);
  /*
   * 内容最后更新日期。来自 `src/content/docs/last-updated.json`（真源，进版本控制），
   * **不是构建时间** —— 每天重新构建不会让日期变化。
   *
   * 注意 key 用的是 `sourcePathFor()` 解析后的**实际**源文件路径：
   * 多语言 docSet 可能回退到共享源文件（`fallbackSourcePrefix`），
   * 此时它与共享源文件的更新日期一致，这是正确语义 —— 内容确实是同一份。
   */
  const lastUpdated = resolveLastUpdated(sourcePath);
  const outputPath = join(outputRoot, docSet.outputPrefix, `${doc.slug}.mdx`);
  ensureDir(dirname(outputPath));
  writeFileSync(
    outputPath,
    [
      '---',
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(description)}`,
      // 正文自带「摘要 / Summary」段的文章（如 Hermes Agent 解读系列），页面上不再
      // 重复渲染 description 段落；description 仍写入 frontmatter 供 SEO meta 使用。
      ...(doc.hideDescription ? ['hide_description: true'] : []),
      `source_path: ${JSON.stringify(sourcePath)}`,
      ...(lastUpdated ? [`last_updated: ${JSON.stringify(lastUpdated)}`] : []),
      '---',
      '',
      body,
      '',
    ].join('\n'),
  );
  return { slug: doc.slug, locale: docSet.outputPrefix, lastUpdated };
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

function writeRouteManifest(lastUpdatedByLocale) {
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
      '/**',
      ' * 每个文档路由的内容最后更新日期（YYYY-MM-DD），key 为 slug 段用 "/" 连接。',
      ' *',
      ' * ⚠️ 本常量是**生成产物**，由 `scripts/sync-fumadocs-content.mjs` 从',
      ' * `src/content/docs/last-updated.json`（唯一真源）写出。**不要手工编辑**：',
      ' * 下次 sync 会覆盖，且会与真源漂移。改日期请改真源后重跑 sync。',
      ' *',
      ' * 日期语义是「内容最后更新日」而**不是构建时间**：每天重新构建不会让它变化，',
      ' * 只有内容真的改了才变（Google 要求 lastmod 一致准确，否则会忽略整个信号）。',
      ' * 初始值由 `docs-last-updated.mjs --from-git` 从 git 历史逐篇生成，',
      ' * 因此各篇日期不同、反映真实批次，而非全站同一天。',
      ' *',
      ' * 供 sitemap 的 `<lastmod>` 与文档页「最后更新于」共用，不存在第二处时间镜像。',
      ' * 一致性由 `scripts/docs-last-updated.test.ts` 断言（产物 ↔ 真源逐条比对）。',
      ' *',
      ' * 类型用显式注解而非 `as const satisfies`：内层键是运行时拼出的 slug 字符串，',
      ' * 字面量类型无法用 `string` 索引（TS7053），只能靠类型断言绕开。',
      ' * 显式声明为 `Record<string, string | undefined>` 后既零断言，',
      ' * 返回类型也诚实（key 不存在时确实是 undefined）。',
      ' */',
      `export const DOCS_LAST_UPDATED: Record<DocsRouteLocale, Record<string, string | undefined>> = ${JSON.stringify(lastUpdatedByLocale, null, 2)};`,
      '',
      'export function docsLastUpdated(locale: DocsRouteLocale, slug: readonly string[] = []): string | undefined {',
      "  const key = slug.join('/');",
      '  return DOCS_LAST_UPDATED[locale][key];',
      '}',
      '',
      'export function isDocsRouteSlug(locale: DocsRouteLocale, slug: readonly string[] = []) {',
      "  const key = slug.join('/');",
      "  return DOCS_ROUTE_SLUGS[locale].some((candidate) => candidate.join('/') === key);",
      '}',
      '',
    ].join('\n'),
  );
}

function syncFumadocsContent() {
  rmSync(outputRoot, { recursive: true, force: true });
  ensureDir(outputRoot);
  copyImages();
  const lastUpdatedByLocale = Object.fromEntries(docSets.map((docSet) => [docSet.outputPrefix, {}]));
  for (const docSet of docSets) {
    for (const doc of docSet.docs) {
      const written = writeDoc(docSet, doc);
      if (written.lastUpdated) {
        lastUpdatedByLocale[docSet.outputPrefix][slugSegments(doc.slug).join('/')] = written.lastUpdated;
      }
    }
    writeMetaForDocSet(docSet);
  }
  /*
   * `/docs/`（空 slug）渲染的是 overview 的内容，所以它的更新日期就是 overview 的日期。
   * 不给它单独造一个日期，避免出现「同一份内容两个时间」的矛盾。
   */
  for (const locale of Object.keys(lastUpdatedByLocale)) {
    const overview = lastUpdatedByLocale[locale].overview;
    if (overview) lastUpdatedByLocale[locale][''] = overview;
  }
  writeRouteManifest(lastUpdatedByLocale);

  const total = docSets.reduce((count, docSet) => count + docSet.docs.length, 0);
  console.log(`[sync-fumadocs-content] synced ${total} docs from ${relative(frontendRoot, sourceRoot)}`);
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  syncFumadocsContent();
}
