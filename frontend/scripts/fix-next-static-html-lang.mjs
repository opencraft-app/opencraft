import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outRoot = join(process.cwd(), 'out');
const buildRegion = process.env.NEXT_PUBLIC_REGION || process.env.VITE_REGION || process.env.FRONTEND_RELEASE_REGION || 'cn';
const defaultHtmlLang = buildRegion === 'global' ? 'en-US' : 'zh-CN';

function walkHtml(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkHtml(path));
    } else if (entry.isFile() && path.endsWith('.html')) {
      files.push(path);
    }
  }
  return files;
}

function langForOutputPath(path) {
  const relative = path.slice(outRoot.length + 1).replaceAll('\\', '/');
  if (relative.startsWith('en-us/')) return 'en-US';
  if (relative.startsWith('zh-cn/')) return 'zh-CN';
  if (relative.startsWith('zh-sg/')) return 'zh-SG';
  if (relative.startsWith('zh-hant/')) return 'zh-Hant';
  return defaultHtmlLang;
}

const ignoredRouteDirs = new Set(['.edgeone', '_next']);
const textReferenceExtensions = new Set(['.html', '.txt', '.js', '.css', '.json']);
const htmlCacheHeaders = { 'cache-control': 'no-cache' };
const nextStaticCacheHeaders = { 'cache-control': 'public, max-age=31536000, immutable' };
const maxEdgeOneConfigBytes = 16 * 1024;
const maxFlightRouteSourceBytes = 480;

function routePathForDirectory(dir) {
  const relative = dir.slice(outRoot.length).replaceAll('\\', '/');
  return relative || '/';
}

function collectNextFlightRoutePaths() {
  const routePaths = [];

  function visit(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'index.txt')) {
      const routePath = routePathForDirectory(dir);
      if (routePath !== '/') routePaths.push(routePath.slice(1));
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignoredRouteDirs.has(entry.name)) continue;
      visit(join(dir, entry.name));
    }
  }

  visit(outRoot);
  return routePaths.sort();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextFlightSource(routePaths) {
  return `^/(${routePaths.join('|')})\\.txt$`;
}

function collectNextFlightRoutes() {
  const routes = [];
  let current = [];

  function flush() {
    if (current.length === 0) return;
    routes.push({ src: nextFlightSource(current), dest: '/$1/index.txt', headers: htmlCacheHeaders });
    current = [];
  }

  for (const routePath of collectNextFlightRoutePaths().map(escapeRegex)) {
    const candidate = nextFlightSource([...current, routePath]);
    if (current.length > 0 && Buffer.byteLength(candidate) > maxFlightRouteSourceBytes) {
      flush();
    }
    current.push(routePath);
    if (Buffer.byteLength(nextFlightSource(current)) > maxFlightRouteSourceBytes) {
      throw new Error(`EdgeOne Flight route exceeds ${maxFlightRouteSourceBytes} bytes: ${routePath}`);
    }
  }
  flush();

  return routes;
}

function writeEdgeOneBuildOutput() {
  const edgeOneRoot = join(outRoot, '.edgeone');
  const assetsRoot = join(edgeOneRoot, 'assets');
  const functionRoot = join(edgeOneRoot, 'cloud-functions', 'ssr-node');
  const stalePaths = ['edge-functions', '_agents_static', 'edgeone.json'];

  rmSync(edgeOneRoot, { force: true, recursive: true });
  for (const stalePath of stalePaths) {
    rmSync(join(outRoot, stalePath), { force: true, recursive: true });
  }

  mkdirSync(assetsRoot, { recursive: true });
  for (const entry of readdirSync(outRoot, { withFileTypes: true })) {
    if (entry.name === '.edgeone') continue;
    cpSync(join(outRoot, entry.name), join(assetsRoot, entry.name), { force: true, recursive: true });
  }

  const routes = [
    { src: '^/__releases/([^/]+)/_next/static/(.*)$', headers: nextStaticCacheHeaders, continue: true },
    { src: '^/(.*)\\.html$', headers: htmlCacheHeaders, continue: true },
    { src: '^/$', dest: '/index.html', headers: htmlCacheHeaders },
    { src: '^/\\.txt$', dest: '/index.txt', headers: htmlCacheHeaders },
    ...collectNextFlightRoutes(),
    { src: '^/(.*)\\.txt$', headers: htmlCacheHeaders, continue: true },
    { handle: 'filesystem' },
    { src: '^/([^.]+[^/.])/?$', dest: '/$1/index.html', headers: htmlCacheHeaders },
  ];
  const config = { version: 3, routes };
  const configBytes = Buffer.byteLength(JSON.stringify(config));
  if (configBytes > maxEdgeOneConfigBytes) {
    throw new Error(`EdgeOne Build Output config exceeds ${maxEdgeOneConfigBytes} bytes: ${configBytes}`);
  }

  mkdirSync(functionRoot, { recursive: true });
  writeFileSync(join(functionRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(functionRoot, 'handler.js'), [
    "export default function handler() {",
    "  return new Response('not found', { status: 404 });",
    "}",
    "",
  ].join('\n'));
  console.log(`[fix-next-static-html-lang] wrote EdgeOne Build Output routes: ${routes.length}`);
}

function walkTextReferenceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextReferenceFiles(path));
    } else if (entry.isFile() && textReferenceExtensions.has(path.slice(path.lastIndexOf('.')))) {
      files.push(path);
    }
  }
  return files;
}

function pruneUnreferencedDocsImages() {
  const docsImagesRoot = join(outRoot, 'docs-images');
  if (!existsSync(docsImagesRoot)) return;

  const hasReference = walkTextReferenceFiles(outRoot).some((file) => readFileSync(file, 'utf8').includes('/docs-images/'));
  if (hasReference) {
    console.log('[fix-next-static-html-lang] kept docs-images because output still references /docs-images/');
    return;
  }

  rmSync(docsImagesRoot, { force: true, recursive: true });
  console.log('[fix-next-static-html-lang] removed unreferenced docs-images output');
}

if (!existsSync(outRoot) || !statSync(outRoot).isDirectory()) {
  throw new Error(`missing Next static output directory: ${outRoot}`);
}

let changed = 0;
for (const file of walkHtml(outRoot)) {
  const html = readFileSync(file, 'utf8');
  const next = html.replace(/<html lang="[^"]*"/, `<html lang="${langForOutputPath(file)}"`);
  if (next !== html) {
    writeFileSync(file, next);
    changed += 1;
  }
}

console.log(`[fix-next-static-html-lang] updated ${changed} HTML files`);
pruneUnreferencedDocsImages();
if (process.env.NEXT_WRITE_EDGEONE_BUILD_OUTPUT === '0') {
  rmSync(join(outRoot, '.edgeone'), { force: true, recursive: true });
  console.log('[fix-next-static-html-lang] skipped EdgeOne Build Output by NEXT_WRITE_EDGEONE_BUILD_OUTPUT=0');
} else {
  writeEdgeOneBuildOutput();
}
