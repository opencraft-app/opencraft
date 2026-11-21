import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: { jar: { type: 'string' }, output: { type: 'string' }, java: { type: 'string', default: 'java' } } });
if (!values.jar || !values.output) throw Error('Usage: node scripts/check/check-thread-catalog-model.mjs --jar /path/tla2tools.jar --output /new/evidence-directory [--java java]');
const jar = path.resolve(values.jar), output = path.resolve(values.output);
if (existsSync(output)) throw Error('Use a new evidence directory; do not overwrite earlier model-check receipts');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), directory = path.join(root, 'specs/thread-catalog');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jarSha256 = hash(readFileSync(jar));
// Official pinned TLA+ tools. No binary, credentials, downloader or live service is embedded in source.
if (jarSha256 !== '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88') throw Error('Unexpected TLA+ tools jar; review tool provenance before changing the pin');
mkdirSync(output, { recursive: true, mode: 0o700 });
const cases = [
  ['CatalogMerge', 'merge-fixed', 0, /Model checking completed\. No error has been found\./],
  ['CatalogMerge', 'merge-legacy', 12, /Invariant (?:UntouchedRows|PatchOwnership) is violated/],
  ['CatalogOwnership', 'ownership-fixed', 0, /Model checking completed\. No error has been found\./],
  ['CatalogOwnership', 'ownership-two-writes', 0, /Model checking completed\. No error has been found\./],
  ['CatalogOwnership', 'ownership-legacy-ack', 12, /Invariant NoRegression is violated/],
  ['CatalogOwnership', 'ownership-legacy-scope', 12, /Invariant ScopeIsolation is violated/],
  ['CatalogOwnership', 'ownership-unfair', 13, /Temporal properties were violated/],
  ['CatalogCollaboration', 'collaboration-fixed', 0, /Model checking completed\. No error has been found\./],
  ['CatalogCollaboration', 'collaboration-two-writes', 0, /Model checking completed\. No error has been found\./],
  ['CatalogCollaboration', 'collaboration-local-only', 12, /Invariant BroadcastCoverage is violated/],
  ['CatalogCollaboration', 'collaboration-retired-response', 12, /Invariant NoRevokedDisplay is violated/],
  ['CatalogCollaboration', 'collaboration-stale-snapshot', 12, /Invariant NoRegression is violated/],
];
const results = [];
for (const [module, name, expectedExit, expectedText] of cases) {
  const result = spawnSync(values.java, ['-Xmx512m', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-metadir', path.join(output, name), '-config', name + '.cfg', module],
    { cwd: directory, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(path.join(output, name + '.log'), log, { mode: 0o600 });
  const passed = !result.error && result.status === expectedExit && expectedText.test(log);
  results.push({ name, passed, expectedExit, actualExit: result.status, expectedCounterexample: expectedExit !== 0,
    specificationSha256: hash(readFileSync(path.join(directory, module + '.tla'))), configurationSha256: hash(readFileSync(path.join(directory, name + '.cfg'))),
    states: log.match(/(\d+) states generated, (\d+) distinct states found/g)?.at(-1) ?? null,
    error: result.error?.message ?? null });
  console.log(JSON.stringify(results.at(-1)));
  if (!passed) break;
}
const receipt = { schema: 1, jarSha256, boundedModelOnly: true, productionImplementationVerified: false,
  bounds: { collaboration: '2 independent clients, 1 shared field, 1 and 2 authoritative commits; per-client queues, disconnect, dropped events, lagging reads and revocation', merge: '2 thread identities, 2 overlapping page contributions, 3 mutation kinds', ownership: '3 owner-field keys / 1 commit and 2 keys / 2 commits; 2 scopes; duplicate deliveries are stuttering steps' },
  fairness: 'Convergence requires eventual quiescence and an eventually successful admitted authoritative refresh; the unfair control must fail',
  results, passed: results.length === cases.length && results.every(result => result.passed) };
writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
if (!receipt.passed) process.exitCode = 1;
