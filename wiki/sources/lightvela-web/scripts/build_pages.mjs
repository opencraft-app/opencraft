import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync('pnpm', ['build'], { cwd: project, stdio: 'inherit', env: { ...process.env, VITE_REPORT_PROTECTED: 'true' } });
if (build.status !== 0) process.exit(build.status ?? 1);
const output = resolve(project, 'cloudflare-dist');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// The dedicated output prevents accidentally publishing an unprotected Vite dist.
const { cpSync } = await import('node:fs');
cpSync(resolve(project, 'dist'), output, { recursive: true });
copyFileSync(resolve(project, 'cloudflare/worker.mjs'), resolve(output, '_worker.js'));
copyFileSync(resolve(project, 'cloudflare/routes.json'), resolve(output, '_routes.json'));
const routes = JSON.parse(readFileSync(resolve(output, '_routes.json'), 'utf8'));
if (!existsSync(resolve(output, 'index.html')) || routes.include[0] !== '/*' || routes.exclude.length) throw new Error('Protected build is incomplete');
console.log('Cloudflare protected build ready: cloudflare-dist/');
