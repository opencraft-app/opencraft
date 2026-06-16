import fs from 'node:fs';
import path from 'node:path';

const [mode, rootArg, docsSiteArg] = process.argv.slice(2);
if (!mode || !rootArg || !docsSiteArg) {
  console.error('usage: aggregate-docs.mjs <prepare|finalize> <repo-root> <docs-site-dir>');
  process.exit(2);
}

const rootDir = path.resolve(rootArg);
const docsSiteDir = path.resolve(docsSiteArg);
const generatedDir = path.join(docsSiteDir, 'generated');
const docsIndexDir = path.join(generatedDir, 'docs-index');
const llmsDir = path.join(generatedDir, 'llms');
const openapiDir = path.join(docsSiteDir, 'openapi');
const asyncapiDir = path.join(docsSiteDir, 'asyncapi');
const componentsDir = path.join(docsSiteDir, 'content', 'docs', 'components');
const fragmentBundleFile = path.join(generatedDir, 'docs-index.fragments.json');

const SKIP_TOP_LEVEL = new Set([
  '.agents',
  '.codebuddy',
  '.git',
  '.rules',
  '.secret',
  'assets',
  'ci-probes',
  'docs-site',
  'node_modules',
  'scripts',
  'shared',
  'staticpages',
]);

const API_NAME_RE = /^(openapi|swagger|asyncapi)([-_.].*)?\.(json|ya?ml)$/i;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(`${file}.tmp`, content);
  fs.renameSync(`${file}.tmp`, file);
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function relativeToRoot(file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

function sanitizeComponentId(value) {
  return value
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function mdEscape(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function jsonWrite(file, data) {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

function firstHeading(file) {
  for (const line of readText(file).split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return path.basename(file, path.extname(file));
}

function topLevelDirs() {
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !SKIP_TOP_LEVEL.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      id: sanitizeComponentId(entry.name),
      absPath: path.join(rootDir, entry.name),
      relPath: entry.name,
    }))
    .filter((entry) => entry.id);
}

function walkFiles(dir, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const results = [];

  function walk(current, depth) {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }

  if (fs.existsSync(dir)) walk(dir, 0);
  return results;
}

function collectKeyDocs(component) {
  const candidates = [];
  const directNames = ['README.md', 'AGENTS.md', 'TEST.md'];
  for (const name of directNames) {
    const file = path.join(component.absPath, name);
    if (fs.existsSync(file)) candidates.push(file);
  }

  for (const docsDirName of ['docs', 'gateway/docs', 'wisp/docs', 'mychat/docs']) {
    const docsDir = path.join(component.absPath, docsDirName);
    if (!fs.existsSync(docsDir)) continue;
    for (const file of walkFiles(docsDir, { maxDepth: 1 })) {
      if (file.endsWith('.md') || file.endsWith('.mdx')) candidates.push(file);
    }
  }

  return [...new Set(candidates)].sort().map((file) => ({
    kind: path.basename(file).toLowerCase() === 'agents.md' ? 'agents' : path.basename(file).toLowerCase() === 'readme.md' ? 'readme' : 'docs',
    path: relativeToRoot(file),
    title: firstHeading(file),
  }));
}

function apiIdForFile(component, file) {
  const relFromComponent = path.relative(component.absPath, file).split(path.sep);
  const significant = relFromComponent.filter((part) => !['api', 'docs', 'gateway'].includes(part));
  const stem = significant.slice(0, -1).join('-');
  const suffix = stem ? `-${stem}` : '';
  return sanitizeComponentId(`${component.id}${suffix}`);
}

function collectApis(component) {
  const files = walkFiles(component.absPath, { maxDepth: 5 }).filter((file) => API_NAME_RE.test(path.basename(file)));
  const byId = new Map();

  for (const file of files) {
    const basename = path.basename(file).toLowerCase();
    const kind = basename.startsWith('asyncapi') ? 'asyncapi' : 'openapi';
    const id = apiIdForFile(component, file);
    const ext = path.extname(file).toLowerCase() === '.json' ? 'json' : 'yaml';
    const existing = byId.get(`${kind}:${id}`);
    const rank = ext === 'json' ? 2 : 1;
    if (!existing || rank > existing.rank) {
      byId.set(`${kind}:${id}`, { kind, id, file, ext, rank });
    }
  }

  return [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind))
    .map(({ kind, id, file, ext }) => {
      const targetDir = kind === 'asyncapi' ? asyncapiDir : openapiDir;
      const target = path.join(targetDir, `${id}.${ext}`);
      ensureDir(targetDir);
      fs.copyFileSync(file, target);
      return {
        kind,
        id,
        source_path: relativeToRoot(file),
        path: relativeToRoot(target),
        url: `/${kind}/${id}`,
        reference_url: kind === 'openapi' ? `/reference/${id}` : undefined,
      };
    });
}

function componentHasScript(component) {
  return fs.existsSync(path.join(component.absPath, 'makedocs.sh'));
}

function buildLLMText(component, docs, apis, level) {
  const lines = [
    `# ${component.name}`,
    '',
    `Component ID: ${component.id}`,
    `Source path: ${component.relPath}`,
    `Docs contract level: ${level}`,
    '',
    '## Key documentation',
  ];

  if (docs.length === 0) {
    lines.push('- No README, AGENTS.md, TEST.md, or shallow docs files were found.');
  } else {
    for (const doc of docs) lines.push(`- ${doc.title}: ${doc.path}`);
  }

  if (apis.length > 0) {
    lines.push('', '## API surfaces');
    for (const api of apis) {
      lines.push(`- ${api.kind}: ${api.url}${api.reference_url ? ` (${api.reference_url})` : ''} from ${api.source_path}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeComponentPage(component, docs, apis, level) {
  const file = path.join(componentsDir, `${component.id}.mdx`);
  const title = `${component.name} Docs Index`;
  const zhTitle = `${component.name} 文档索引`;

  const lines = [
    '---',
    `title: ${title} / ${zhTitle}`,
    `title_en: ${title}`,
    `title_zh: ${zhTitle}`,
    `description: Generated Level ${level} documentation index for ${component.name}. ${component.name} 的 Level ${level} 生成式文档索引。`,
    `description_en: Generated Level ${level} documentation index for ${component.name}.`,
    `description_zh: ${component.name} 的 Level ${level} 生成式文档索引。`,
    `owner: ${component.id}`,
    'status: active',
    'last_reviewed: "2026-06-16"',
    'tags:',
    `  - ${component.id}`,
    '  - generated',
    '  - makedocs',
    `source_path: ${component.relPath}`,
    '---',
    '',
    '<p>',
    `  <span className="lang-en">This page is generated from the mono2 docs contract without component-specific business logic.</span>`,
    `  <span className="lang-zh">本页面由 mono2 文档契约生成，不包含组件特定业务逻辑。</span>`,
    '</p>',
    '',
    '## <span className="lang-en">Key Documentation</span><span className="lang-zh">关键文档</span>',
    '',
  ];

  if (docs.length === 0) {
    lines.push('<p><span className="lang-en">No key documentation files were found.</span><span className="lang-zh">未发现关键文档文件。</span></p>');
  } else {
    lines.push('| Source path | <span className="lang-en">Title</span><span className="lang-zh">标题</span> |');
    lines.push('| --- | --- |');
    for (const doc of docs) lines.push(`| \`${mdEscape(doc.path)}\` | ${mdEscape(doc.title)} |`);
  }

  if (apis.length > 0) {
    lines.push('', '## <span className="lang-en">API References</span><span className="lang-zh">API 参考</span>', '');
    lines.push('| Kind | ID | Source | Reference |');
    lines.push('| --- | --- | --- | --- |');
    for (const api of apis) {
      const reference = api.reference_url ? `[Scalar](${api.reference_url})` : api.url;
      lines.push(`| ${api.kind} | \`${api.id}\` | \`${mdEscape(api.source_path)}\` | ${reference} |`);
    }
  }

  writeFileAtomic(file, `${lines.join('\n')}\n`);
}

function writeComponentsIndex(components) {
  const pages = components.map((component) => component.id).sort();
  jsonWrite(path.join(componentsDir, 'meta.json'), {
    title: 'Components',
    pages: ['index', ...pages],
  });

  const lines = [
    '---',
    'title: Component Docs Index / 组件文档索引',
    'title_en: Component Docs Index',
    'title_zh: 组件文档索引',
    'description: Generated overview of mono2 component documentation fragments. mono2 组件文档片段的生成式总览。',
    'description_en: Generated overview of mono2 component documentation fragments.',
    'description_zh: mono2 组件文档片段的生成式总览。',
    'owner: platform',
    'status: active',
    'last_reviewed: "2026-06-16"',
    'tags:',
    '  - generated',
    '  - makedocs',
    'source_path: docs-site/scripts/aggregate-docs.mjs',
    '---',
    '',
    '<p>',
    '  <span className="lang-en">Level 0 components are indexed by the root docs aggregator. Level 1 and Level 2 components own their own `makedocs.sh` outputs.</span>',
    '  <span className="lang-zh">Level 0 组件由根文档聚合器索引。Level 1 和 Level 2 组件由自己的 `makedocs.sh` 维护输出。</span>',
    '</p>',
    '',
    '| Component | Level | Docs | APIs | LLM |',
    '| --- | ---: | ---: | ---: | --- |',
  ];

  for (const component of components.sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(
      `| [${component.name}](/docs/components/${component.id}) | ${component.level} | ${component.docs.length} | ${component.apis.length} | [/llms/${component.id}.txt](/llms/${component.id}.txt) |`,
    );
  }

  writeFileAtomic(path.join(componentsDir, 'index.mdx'), `${lines.join('\n')}\n`);
}

function readExistingFragment(component) {
  const file = path.join(docsIndexDir, `${component.id}.json`);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(readText(file));
}

function writeFallbackFragment(component, docs, apis, level) {
  const generated = [
    {
      kind: 'mdx',
      path: `docs-site/content/docs/components/${component.id}.mdx`,
      url: `/docs/components/${component.id}`,
    },
    {
      kind: 'llms',
      path: `docs-site/generated/llms/${component.id}.txt`,
      url: `/llms/${component.id}.txt`,
    },
    ...apis.map((api) => ({
      kind: api.kind,
      path: api.path,
      url: api.url,
      reference_url: api.reference_url,
    })),
  ];

  jsonWrite(path.join(docsIndexDir, `${component.id}.json`), {
    object: 'mono2.docs.fragment',
    version: 'v1',
    level,
    component: component.id,
    component_path: component.relPath,
    owner: component.id,
    source_path: component.relPath,
    docs,
    apis,
    generated,
  });
}

function mergeComponentMetadata(component, existing, docs, apis, level) {
  const existingGenerated = Array.isArray(existing?.generated) ? existing.generated : [];
  const componentPageGenerated = {
    kind: 'mdx',
    path: `docs-site/content/docs/components/${component.id}.mdx`,
    url: `/docs/components/${component.id}`,
  };
  const llmsGenerated = {
    kind: 'llms',
    path: `docs-site/generated/llms/${component.id}.txt`,
    url: `/llms/${component.id}.txt`,
  };
  const apiGenerated = apis.map((api) => ({
    kind: api.kind,
    path: api.path,
    url: api.url,
    reference_url: api.reference_url,
  }));
  const generated = [componentPageGenerated, ...existingGenerated, llmsGenerated, ...apiGenerated].filter(
    (entry, index, entries) => entries.findIndex((candidate) => candidate.kind === entry.kind && candidate.path === entry.path) === index,
  );

  jsonWrite(path.join(docsIndexDir, `${component.id}.json`), {
    ...existing,
    object: 'mono2.docs.fragment',
    version: existing?.version ?? 'v1',
    level,
    component: existing?.component ?? component.id,
    component_path: existing?.component_path ?? component.relPath,
    owner: existing?.owner ?? component.id,
    source_path: existing?.source_path ?? path.posix.join(component.relPath, 'makedocs.sh'),
    docs: existing?.docs ?? docs,
    apis: [...(existing?.apis ?? []), ...apis].filter(
      (entry, index, entries) => entries.findIndex((candidate) => candidate.kind === entry.kind && candidate.id === entry.id) === index,
    ),
    generated,
  });
}

function bundleFragments() {
  const fragments = [];
  if (fs.existsSync(docsIndexDir)) {
    for (const name of fs.readdirSync(docsIndexDir).sort()) {
      if (!name.endsWith('.json')) continue;
      fragments.push(JSON.parse(readText(path.join(docsIndexDir, name))));
    }
  }

  jsonWrite(fragmentBundleFile, {
    object: 'mono2.docs.fragments',
    version: 'v1',
    generated_from: 'makedocs.sh',
    fragments,
  });
  console.log(`[makedocs] wrote ${relativeToRoot(fragmentBundleFile)}`);
}

function prepare() {
  removeDir(docsIndexDir);
  removeDir(llmsDir);
  removeDir(openapiDir);
  removeDir(asyncapiDir);
  removeDir(componentsDir);
  ensureDir(docsIndexDir);
  ensureDir(llmsDir);
  ensureDir(openapiDir);
  ensureDir(asyncapiDir);
  ensureDir(componentsDir);
}

function finalize() {
  const componentSummaries = [];

  for (const component of topLevelDirs()) {
    const docs = collectKeyDocs(component);
    const apis = collectApis(component);
    const hasScript = componentHasScript(component);
    const existing = readExistingFragment(component);
    const combinedApis = [...(existing?.apis ?? []), ...apis].filter(
      (entry, index, entries) => entries.findIndex((candidate) => candidate.kind === entry.kind && candidate.id === entry.id) === index,
    );
    const level = combinedApis.length > 0 ? 2 : hasScript || existing ? 1 : 0;

    if (docs.length === 0 && apis.length === 0 && !hasScript && !existing) continue;

    const llmsFile = path.join(llmsDir, `${component.id}.txt`);
    if (!fs.existsSync(llmsFile)) {
      writeFileAtomic(llmsFile, buildLLMText(component, docs, combinedApis, level));
    }

    writeComponentPage(component, docs, combinedApis, level);

    if (existing || hasScript) {
      mergeComponentMetadata(component, existing ?? {}, docs, apis, level);
    } else {
      writeFallbackFragment(component, docs, apis, level);
    }

    componentSummaries.push({ ...component, docs, apis: combinedApis, level });
  }

  writeComponentsIndex(componentSummaries);
  bundleFragments();
}

if (mode === 'prepare') prepare();
else if (mode === 'finalize') finalize();
else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
