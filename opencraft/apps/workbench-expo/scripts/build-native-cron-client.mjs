import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '../../..');
const source = path.join(repoRoot, 'frontend/src/lib/hermes-cron-client.ts');
const port = path.join(appRoot, 'src/runtime/native-cron-port.ts');
const agentCommand = path.join(repoRoot, 'frontend/src/lib/hermes-agent-command.ts');
const output = path.join(appRoot, 'src/generated/native-cron-client.js');
await mkdir(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: `export * from ${JSON.stringify(source)};`,
    sourcefile: 'native-cron-entry.ts',
    resolveDir: appRoot,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  define: {
    'import.meta.env': '{}',
    'process.env.NEXT_PUBLIC_LOCAL_PREVIEW_AUTH': '"0"',
    'process.env.VITE_LOCAL_PREVIEW_AUTH': '"0"',
    window: 'undefined',
  },
  plugins: [{
    name: 'native-cron-port',
    setup(plugin) {
      plugin.onResolve({ filter: /^@\/lib\/(auth-api-base|debug-exec-request)$/ }, () => ({ path: port }));
      plugin.onResolve({ filter: /^@\/repositories\/http-repositories$/ }, () => ({ path: port }));
      plugin.onResolve({ filter: /^@\/lib\/hermes-agent-command$/ }, () => ({ path: agentCommand }));
    },
  }],
});
const bundled = await readFile(output, 'utf8');
if (/\b(?:window|document|localStorage|sessionStorage)\s*\./.test(bundled)) {
  throw new Error('Native Cron bundle unexpectedly contains a DOM dependency');
}
process.stdout.write(`Bundled frontend Hermes Cron client for Expo: ${path.relative(repoRoot, output)}\n`);
