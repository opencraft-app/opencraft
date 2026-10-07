import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const monoRoot = path.resolve(appRoot, '../../..');
const frontendRoot = path.join(monoRoot, 'frontend');
const requireOpenCraft = createRequire(path.join(monoRoot, 'opencraft/package.json'));
const requireFrontend = createRequire(path.join(frontendRoot, 'package.json'));
const esbuild = requireOpenCraft('esbuild');
const postcss = requireOpenCraft('postcss');
const tailwind = requireFrontend('@tailwindcss/postcss');

const generatedFile = path.join(appRoot, 'assets/mobile-bot-runtime.html');
const entryPoint = path.join(frontendRoot, 'src/mobile-dom/entry.tsx');
const globalCss = path.join(frontendRoot, 'src/app/global.css');
const embeddedLayoutCss = path.join(frontendRoot, 'src/mobile-dom/embedded-layout.css');
const productionEnv = await fs.readFile(path.join(frontendRoot, '.env.production'), 'utf8');
const aiServerBase = productionEnv.match(/^NEXT_PUBLIC_AI_SERVER_BASE_URL=(.+)$/m)?.[1]?.trim();
if (!aiServerBase || !/^https:\/\/[^\s]+$/.test(aiServerBase)) {
  throw new Error('A public AI server base URL is required for the embedded connector UI');
}

const result = await esbuild.build({
  entryPoints: [entryPoint],
  absWorkingDir: frontendRoot,
  bundle: true,
  minify: true,
  write: false,
  outdir: path.join(appRoot, 'dist/mobile-dom-build'),
  platform: 'browser',
  format: 'esm',
  target: ['safari16'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: false,
  logLevel: 'silent',
  alias: { '@': path.join(frontendRoot, 'src') },
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.css': 'css',
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.jpeg': 'dataurl',
    '.webp': 'dataurl',
    '.gif': 'dataurl',
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
  },
  plugins: [{
    name: 'frontend-local-css-modules',
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, async ({ path: sourcePath }) => ({
        contents: await fs.readFile(sourcePath, 'utf8'),
        loader: 'local-css',
        resolveDir: path.dirname(sourcePath),
      }));
    },
  }],
});

const script = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
if (!script) throw new Error('The embedded Bot JavaScript bundle was not generated');
const componentCss = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const globalSource = await fs.readFile(globalCss, 'utf8');
const embeddedLayoutSource = await fs.readFile(embeddedLayoutCss, 'utf8');
// Tailwind v4 scans relative to its base. Expo runs this script from opencraft/,
// while the reused class names live in frontend/.
const compiledGlobalCss = (await postcss([tailwind({ base: frontendRoot })]).process(globalSource, { from: globalCss })).css;
const css = await esbuild.transform(`${compiledGlobalCss}\n${componentCss}\n${embeddedLayoutSource}`, { loader: 'css', minify: true });
const escapeClosingTag = (value, tag) => value.replaceAll(`</${tag}`, `<\\/${tag}`);
// The frontend also runs under Next.js, where process.env exists. WKWebView has no
// process global, so provide only the browser values needed by the bundled code.
// Region and API base stay dynamic because the same asset serves both regions.
const browserProcess = `const process = {
  env: {
    NODE_ENV: 'production',
    NEXT_PUBLIC_REGION: window.__LIGHTVELA_EMBEDDED_REGION__ === 'global' ? 'global' : 'cn',
    NEXT_PUBLIC_AUTH_API_BASE_URL: window.__LIGHTVELA_EMBEDDED_API_BASE__,
    NEXT_PUBLIC_AI_SERVER_BASE_URL: ${JSON.stringify(aiServerBase)},
  },
  cwd: () => '/',
  platform: 'browser',
  nextTick: callback => queueMicrotask(callback),
};
globalThis.process = process;\n`;
const html = `<!doctype html><html class="lv-mobile-bot-runtime"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><style>${escapeClosingTag(css.code, 'style')}</style><style>html,body,#root{min-height:100%;margin:0;background:#faf9fc}.lw-public-site-header,.lv-agents-sidebar{display:none!important}.lv-agent-settings-grid{display:block!important}.lw-app-top-pad{padding-top:0!important}</style></head><body><div id="root"></div><script type="module">${escapeClosingTag(browserProcess + script, 'script')}</script></body></html>`;
await fs.mkdir(path.dirname(generatedFile), { recursive: true });
await fs.writeFile(generatedFile, html);
console.log(`Embedded frontend Bot runtime: ${Buffer.byteLength(html)} bytes → ${generatedFile}`);
