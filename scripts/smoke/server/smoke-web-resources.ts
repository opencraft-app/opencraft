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
    rolldownOptions: { input: resolve('tests/fixtures/optional-pdf-preview.tsx') } } });
const manifest = JSON.parse(await readFile(join(web, '.vite/manifest.json'), 'utf8'));
const entry = manifest['tests/fixtures/optional-pdf-preview.tsx'];
await writeFile(join(web, 'index.html'), `<!doctype html><html><head><meta name="opencraft-build-id" content="resource-smoke">${selfContained ? '' : '<meta name="opencraft-web-resources" content="resource-smoke">'}${(entry.css ?? []).map((file: string) => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="host"></div><script type="module" src="/${entry.file}"></script></body></html>`);
await writeFile(join(web, 'version.json'), JSON.stringify({ buildId: 'resource-smoke' }));
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', '<< /Length 39 >>\nstream\nBT /F1 22 Tf 30 330 Td (Hello PDF) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(join(web, 'fixture.pdf'), pdf);
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
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(await open());
  await page.getByRole('heading', { name: 'Core 中文 workspace' }).waitFor();
  assert.equal(downloads, 0, 'core startup must not download optional resources');
  await page.getByRole('button', { name: 'Open PDF' }).click();
  if (!selfContained) {
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.equal(downloads, 1);
    await page.getByRole('heading', { name: 'Core 中文 workspace' }).waitFor();
    offline = false;
    await page.getByRole('button', { name: 'Try again' }).click();
  }
  await page.locator('[data-pdf-ready="true"]').waitFor({ timeout: 60_000 });
  const ink = await page.locator('.workspace-pdf-preview__page canvas').evaluate(canvas => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i]! < 200 && data[i + 3]! > 0) count++; return count;
  });
  assert.ok(ink > 100, 'PDF must render actual content'); assert.equal(downloads, selfContained ? 0 : 2);
  await page.screenshot({ path: join(root, 'pdf-ready.png') });
  await app!.close(); app = undefined; offline = true;
  await page.goto(await open()); await page.getByRole('button', { name: 'Open PDF' }).click();
  await page.locator('[data-pdf-ready="true"]').waitFor({ timeout: 60_000 });
  assert.equal(downloads, selfContained ? 0 : 2, 'restart must render PDF while registry is offline');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', root, selfContained, downloads, inkPixels: ink, failureRetry: !selfContained, offlineRestart: true, pageErrors: errors };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); await app?.close(); }
