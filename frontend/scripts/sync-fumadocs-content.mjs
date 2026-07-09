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

const cnDocs = [
  { slug: 'announcements/public-beta', title: 'LightVela 付费版本公告', file: 'announcements/public-beta.md', group: '产品公告', description: '' },
  { slug: 'overview', title: 'LightVela 是什么', file: '01-overview.md', group: '开始使用', description: '云端托管 Hermes Agent，越聊越懂的智能伙伴。' },
  { slug: 'quickstart', title: '快速开始', file: '02-quickstart.md', group: '开始使用', description: '5 分钟跑通第一个 LightVela 对话。' },
  { slug: 'account', title: '账号与实名认证', file: '03-account.md', group: '开始使用', description: '账号管理与实名认证流程。' },
  { slug: 'core-concepts', title: '核心概念', file: '04-core-concepts.md', group: '开始使用', description: '理解 Hermes、模型、通道和技能。' },
  { slug: 'configuration/index', title: '配置总览', file: '05-configuration.md', group: '配置指南', description: 'LightVela 管理台配置流程。' },
  { slug: 'configuration/model', title: '配置模型', file: 'configuration/model.md', group: '配置指南', description: '接入和管理 Hermes 使用的大语言模型。' },
  { slug: 'configuration/channel-wechat', title: '配置通道 - 微信', file: 'configuration/channel-wechat.md', group: '配置指南', description: '通过微信与 Hermes Agent 对话。' },
  { slug: 'configuration/channel-feishu', title: '配置通道 - 飞书', file: 'configuration/channel-feishu.md', group: '配置指南', description: '通过飞书与 Hermes Agent 对话。' },
  { slug: 'configuration/channel-qq', title: '配置通道 - QQ', file: 'configuration/channel-qq.md', group: '配置指南', description: '通过 QQ 与 Hermes Agent 对话。' },
  { slug: 'configuration/skill', title: '配置技能', file: 'configuration/skill.md', group: '配置指南', description: '安装技能包，扩展 Hermes 能力。' },
  { slug: 'faq', title: '常见问题 FAQ', file: '07-faq.md', group: '参考', description: 'LightVela 常见问题。' },
  { slug: 'contact-us', title: '联系我们', file: 'contact-us.md', group: '参考', description: '加入 LightVela 内测交流群，与产品团队面对面交流。继续把使用问题、产品建议和真实场景反馈给我们。' },
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

function writeMetaForDocSet(docSet) {
  const root = join(outputRoot, docSet.outputPrefix);
  const isCnLocale = docSet.outputPrefix === 'zh-cn';
  ensureDir(root);
  writeFileSync(
    join(root, 'meta.json'),
    `${JSON.stringify(
      {
        title: docSet.title,
        pages: [...(isCnLocale ? ['announcements'] : []), 'overview', 'quickstart', ...(isCnLocale ? ['account'] : []), 'core-concepts', 'configuration', 'faq', 'contact-us'],
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
          ...(isCnLocale ? [] : ['channel-telegram', 'channel-whatsapp', 'channel-discord']),
          'channel-feishu',
          'channel-qq',
          ...(isCnLocale ? [] : ['channel-wecom']),
          'skill',
          ...(isCnLocale ? [] : ['automation', 'agent-chat']),
        ],
      },
      null,
      2,
    )}\n`,
  );
  if (isCnLocale) {
    ensureDir(join(root, 'announcements'));
    writeFileSync(
      join(root, 'announcements', 'meta.json'),
      `${JSON.stringify(
        {
          title: '产品公告',
          pages: ['public-beta'],
        },
        null,
        2,
      )}\n`,
    );
  }
  ensureDir(join(root, 'faq'));
  writeFileSync(
    join(root, 'faq', 'meta.json'),
    `${JSON.stringify(
      {
        title: docSet.referenceTitle,
        pages: isCnLocale ? [] : ['using-lightvela-safely'],
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
