import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
import { optionalWebAssets } from "../../../apps/workbench-web/optional-web-assets";
import { packageWebResources } from "../../package-web-resources.mjs";
import { packageWebServer } from "../../package-web-server.mjs";
import { createOptionalResources } from "../../web-deployment/optional-resources.mjs";
import { createWorkbenchWebServer } from "../../workbench-web-server.mjs";

await mkdir('.local/web-resource-optimization', { recursive: true });
const selfContained = process.argv.includes('--self-contained');
const root = await mkdtemp(resolve('.local/web-resource-optimization/browser-'));
let packageRoot = join(root, 'package'); let web = join(packageRoot, 'web');
await build({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [optionalWebAssets()],
  esbuild: { jsx: 'automatic' }, build: { target: 'es2022', outDir: web, manifest: true,
    rolldownOptions: { input: resolve('tests/fixtures/optional-office-preview.tsx') } } });
const manifest = JSON.parse(await readFile(join(web, '.vite/manifest.json'), 'utf8'));
const entry = manifest['tests/fixtures/optional-office-preview.tsx'];
await writeFile(join(web, 'index.html'), `<!doctype html><html><head><meta name="opencraft-build-id" content="resource-smoke">${selfContained ? '' : '<meta name="opencraft-web-resources" content="resource-smoke">'}${(entry.css ?? []).map((file: string) => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="host"></div><script type="module" src="/${entry.file}"></script></body></html>`);
await writeFile(join(web, 'version.json'), JSON.stringify({ buildId: 'resource-smoke' }));
for (const kind of ['docx','pptx','xlsx']) await writeFile(join(web, 'sample.'+kind), await readFile('tests/fixtures/office/sample.'+kind));
const packed = selfContained
  ? await packageWebServer({ version: '1.0.0', webRoot: web, output: join(root, 'single') })
  : await packageWebResources({ repositoryRoot: process.cwd(), packageRoot, directory: root, version: '1.0.0', buildId: 'resource-smoke' });
assert.ok(packed);
if (selfContained) { packageRoot = packed.packageRoot; web = join(packageRoot, 'web'); }
let offline = true; let downloads = 0;
const cacheDirectory = join(root, 'cache');
const source = { async download() { downloads++; if (offline) throw new Error('synthetic registry outage'); return packed.archive; } };
let app: Awaited<ReturnType<typeof createWorkbenchWebServer>> | undefined;
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
const errors: string[] = [];
try {
  const open = async () => {
    const resources = await createOptionalResources({ releaseRoot: packageRoot, cacheDirectory, source });
    app = await createWorkbenchWebServer({ root: web, appServerTarget: null, optionalResources: resources });
    return `http://127.0.0.1:${(await app.listen({ host: '127.0.0.1', port: 0 })).port}`;
  };
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(await open());
  await page.getByRole('heading', { name: 'Core 中文 workspace' }).waitFor();
  assert.equal(downloads, 0, 'core startup must not download optional resources');
  await page.getByRole('button', { name: 'Open DOCX' }).click();
  if (!selfContained) {
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.equal(downloads, 1);
    await page.getByRole('heading', { name: 'Core 中文 workspace' }).waitFor();
    offline = false;
    await page.getByRole('button', { name: 'Try again' }).click();
  }
  await page.locator('[data-file-preview-phase="ready"]').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByText('Office preview document',{exact:true}).waitFor();
  for (const kind of ['PPTX','XLSX']) {
    await page.getByRole('button',{name:'Open '+kind}).click();
    await page.locator('.office-preview--' + kind.toLowerCase()).waitFor({ timeout: 60_000 });
  }
  await page.getByRole('tab',{name:'Summary',exact:true}).waitFor();
  await page.getByRole('tab',{name:'Details',exact:true}).click();
  assert.equal(downloads,selfContained?0:2);
  await page.screenshot({path:join(root,'office-ready.png')});
  await app!.close(); app = undefined; offline = true;
  await page.goto(await open()); await page.getByRole('button', { name: 'Open DOCX' }).click();
  await page.getByText('Office preview document',{exact:true}).waitFor({timeout:60_000});
  assert.equal(downloads, selfContained ? 0 : 2, 'restart must render Office documents while registry is offline');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', root, selfContained, downloads, formats: ['DOCX','PPTX','XLSX'], failureRetry: !selfContained, offlineRestart: true, pageErrors: errors };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); await app?.close(); }
