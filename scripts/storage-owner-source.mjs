import ts from 'typescript';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Evaluate only repository code, in disposable tooling, never installed databases. */
export async function readOwnerMigrations(root, store) {
  const owner = join(root, store.owner), source = readFileSync(owner, 'utf8');
  const file = ts.createSourceFile(owner, source, ts.ScriptTarget.Latest, true);
  let expression;
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const registration = registrationOfOptions(node, file);
      if (registration?.id === store.id) {
        if (expression) throw new Error(`Ambiguous storage registration: ${store.id}`);
        expression = registration.expression;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!expression) throw new Error(`Unregistered storage owner: ${store.id}`);
  const runtime = join(root, '.runtime'); mkdirSync(runtime, { recursive: true });
  const scratch = mkdtempSync(join(runtime, 'schema-owner-'));
  try {
    const output = join(scratch, 'owner.mjs');
    await build({ stdin: { contents: source + '\nexport const __storageMigrations = ' + expression + ';\n',
      resolveDir: dirname(owner), sourcefile: owner, loader: 'ts' }, outfile: output,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', treeShaking: true, logLevel: 'silent' });
    return (await import(pathToFileURL(output).href)).__storageMigrations;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Fail new owned callers that bypass the common schema registration. */
export function assertOwnerCoverage(root, stores, directories = ['apps', 'packages', 'plugins', 'scripts']) {
  const known = new Map(stores.map(store => [store.id, store.owner]));
  function scan(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (['node_modules', 'dist', 'build', '.runtime', '.git', 'tests', '__tests__'].includes(entry.name)) continue;
      const path = relative + '/' + entry.name;
      if (entry.isDirectory()) { scan(path); continue; }
      if (!/\.(ts|mjs)$/.test(entry.name) || path.startsWith('packages/storage-node/src/server/') || path === 'packages/sqlite-node/src/lifecycle.ts') continue;
      const text = readFileSync(join(root, path), 'utf8');
      if (!text.includes('openManagedDatabase(')) continue;
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const objects = new Map();
      function collect(node) {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) objects.set(node.name.getText(file), node.initializer);
        ts.forEachChild(node, collect);
      }
      collect(file);
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(file) === 'openManagedDatabase') {
          const argument = node.arguments[0];
          const options = ts.isObjectLiteralExpression(argument) ? argument : objects.get(argument.getText(file));
          const registration = options && registrationOfOptions(options, file);
          if (!registration || known.get(registration.id) !== path) throw new Error(`Owned SQLite caller lacks a registered schema: ${path}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  for (const directory of directories) scan(directory);
}

function registrationOfOptions(node, file) {
  const migrations = node.properties.find(property => property.name?.getText(file) === 'migrations');
  if (!migrations) return null;
  const property = node.properties.find(property => property.name?.getText(file) === 'schemaId');
  let identity = property?.initializer;
  while (identity && ts.isAsExpression(identity)) identity = identity.expression;
  if (identity && ts.isStringLiteral(identity)) return { id: identity.text, expression: migrations.initializer.getText(file) };
  const call = migrations.initializer;
  if (ts.isCallExpression(call) && call.expression.getText(file) === 'resolveMigrationContract' && ts.isStringLiteral(call.arguments[0]))
    return { id: call.arguments[0].text, expression: call.arguments[1].getText(file) };
  return null;
}
