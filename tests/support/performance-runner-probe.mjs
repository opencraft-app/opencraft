// Exercise the real runner's dispatch and receipt flow without running benchmarks.
// Only subprocess execution is replaced; every dispatched source path must exist.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scenarios } from '../../scripts/performance/report.mjs';

const output = path.resolve(process.argv[process.argv.indexOf('--output') + 1]);
const evidence = Object.entries(scenarios).map(([id, metrics]) => ({
  id, samples: Array.from({ length: 10 }, () => Object.fromEntries(metrics.map(metric => [metric, 100]))),
}));
async function receipt(directory, filename, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), JSON.stringify(value));
}
childProcess.spawn = (executable, args, options) => {
  const child = new EventEmitter();
  queueMicrotask(async () => {
    try {
      assert.equal(executable, process.execPath);
      const script = args.find(argument => /\.(?:mjs|ts)$/.test(argument));
      assert.ok(script, 'Each benchmark stage must dispatch an explicit source file');
      const source = path.resolve(options.cwd, script);
      await appendFile(path.join(output, 'invocations.jsonl'), JSON.stringify({ args, source }) + '\n');
      await access(source);
      const env = options.env;
      if (env.OPENCRAFT_COLD_OPEN_EVIDENCE) {
        await receipt(env.OPENCRAFT_COLD_OPEN_EVIDENCE, 'receipt.json', {
          workloadVersion: 5, build: { probe: true }, browser: 'dispatch-probe',
          evidence: evidence.filter(row => row.id.startsWith('session-navigation-')),
        });
      } else if (env.OPENCRAFT_PERFORMANCE_OUTPUT) {
        await receipt(env.OPENCRAFT_PERFORMANCE_OUTPUT, 'workbench.json', {
          workloadVersion: 1, browser: 'dispatch-probe',
          evidence: evidence.filter(row => !row.id.startsWith('session-navigation-') && !row.id.startsWith('sidebar-')),
        });
      } else if (env.OPENCRAFT_SIDEBAR_UPDATE_OUTPUT || env.OPENCRAFT_MENU_LATENCY_OUTPUT) {
        await receipt(env.OPENCRAFT_SIDEBAR_UPDATE_OUTPUT || env.OPENCRAFT_MENU_LATENCY_OUTPUT,
          env.OPENCRAFT_SIDEBAR_UPDATE_OUTPUT ? 'results.json' : 'result.json',
          [30, 200].map(rows => ({ rows, samples: Array.from({ length: 10 }, () => ({ ms: 100, rowsProcessed: 0, projections: 0 })) })));
      }
      child.emit('exit', 0, null);
    } catch (error) { child.emit('error', error); }
  });
  return child;
};
syncBuiltinESMExports();
await import('../../scripts/performance/run.mjs');
