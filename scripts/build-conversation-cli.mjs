import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function buildConversationCli(output) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { version } = JSON.parse(await readFile(new URL('../apps/opencraft-cli/package.json', import.meta.url), 'utf8'));
  let source = 'unknown (source archive)';
  try {
    source = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--', '.'], {encoding:'utf8'}).trim()) source += '-dirty';
  } catch { /* Archives without Git explicitly report unknown provenance. */ }
  await build({
    define: {__OPENCRAFT_CLI_VERSION__:JSON.stringify(version), __OPENCRAFT_CLI_SOURCE__:JSON.stringify(source)}, entryPoints: [fileURLToPath(new URL('../apps/opencraft-cli/src/main.ts', import.meta.url))], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __createCliRequire } from 'node:module'; const require = __createCliRequire(import.meta.url);" } });
  await chmod(output, 0o755);
}
