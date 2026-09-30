import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '../../..');
const app = JSON.parse(readFileSync(path.join(repoRoot, 'apps/workbench-expo/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const notices = Object.keys(app.dependencies)
  .filter(name => !name.startsWith('@opencraft/'))
  .sort((left, right) => left.localeCompare(right))
  .map(name => {
    const entry = lock.packages[`apps/workbench-expo/node_modules/${name}`]
      ?? lock.packages[`node_modules/${name}`];
    if (!entry?.version || !entry.license) {
      throw new Error(`Missing version or license metadata for ${name}`);
    }
    return { name, version: entry.version, license: entry.license };
  });

const output = `${JSON.stringify(notices, null, 2)}\n`;
const destination = path.join(repoRoot, 'apps/workbench-expo/src/assets/mobile-open-source-licenses.json');
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== output) throw new Error('Mobile open-source license list is stale.');
  console.log(`Verified ${notices.length} direct mobile dependencies.`);
} else {
  writeFileSync(destination, output);
  console.log(`Wrote ${notices.length} direct mobile dependencies.`);
}
