import { build } from 'esbuild';
await build({ entryPoints: ['src/codex-main.ts'], outfile: 'dist/codex.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
