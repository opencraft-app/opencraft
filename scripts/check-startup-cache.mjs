#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { headlessWebHostDefinitions } from './package-headless-linux.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, output, variant] = process.argv.slice(2);
if (mode === '--build') {
  // Use one explicit release profile; never inherit a live deployment's hosts.
  Object.assign(process.env, {
    OPENCRAFT_BUILD_TARGET: 'web', OPENCRAFT_PRODUCT: 'opencraft',
    OPENCRAFT_RELEASE_MINIFY: 'standard', OPENCRAFT_HEADLESS_SERVER_BUILD: 'true',
    VITE_HYPERNODE_PLUGIN: 'disabled', VITE_WEB_EXTENSIONS: '',
    VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()),
  });
  const target = join(root, 'apps/workbench-web/src/runtime/bot-management-extension.ts');
  let transformed = false;
  const { build } = await import('vite');
  await build({ root: join(root, 'apps/workbench-web'),
    configFile: join(root, 'apps/workbench-web/vite.config.ts'),
    build: { outDir: output, emptyOutDir: true },
    plugins: variant === 'probe' ? [{ name: 'startup-cache-controlled-probe', enforce: 'pre',
      transform(code, id) {
        if (id !== target) return;
        const changed = code.replace('name: "Bots"', 'name: "Bots cache probe"');
        if (changed === code) throw new Error('Cache probe target changed; review the controlled scenario');
        transformed = true; return { code: changed, map: null };
      },
    }] : [],
  });
  if (variant === 'probe' && !transformed) throw new Error('Cache probe module was not built');
} else {
  if (mode) throw new Error('Usage: check-startup-cache.mjs');
  const temporary = await mkdtemp(join(tmpdir(), 'opencraft-startup-cache-'));
  const evidence = join(root, '.local/startup-cache', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(evidence, { recursive: true });
  const run = args => new Promise((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`Startup cache build exited ${code}`)));
  });
  try {
    for (const name of ['before', 'probe']) {
      await run(['--build', join(temporary, name), name]);
      await copyFile(join(temporary, '.startup', name, 'resources.json'), join(evidence, `${name}.json`));
    }
    const { stdout } = await promisify(execFile)(process.execPath,
      [join(root, 'scripts/compare-startup-resources.mjs'), join(evidence, 'before.json'), join(evidence, 'probe.json'), '--max-invalidated-js', '900000']);
    await writeFile(join(evidence, 'comparison.json'), stdout);
    console.log(stdout);
    console.log(`Startup cache evidence: ${evidence}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
