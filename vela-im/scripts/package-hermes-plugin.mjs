#!/usr/bin/env node
// Packs hermes-plugin/ (with the synced vela_im runtime and worker) into a reproducible tarball for instances.
// CTL downloads it from COS and checks the printed sha256 before installing (ctl api.instance.vela_im_plugin_*).
// Run after `npm run build`. Needs GNU tar for the reproducible flags.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'hermes-plugin');
const out = join(root, 'dist');
for (const required of ['plugin.yaml', 'adapter.py', 'vela_im/_worker/vela-im-worker.mjs']) {
  if (!existsSync(join(plugin, required))) throw new Error(`missing hermes-plugin/${required}; run npm run build first`);
}
const version = /^version:\s*"?([0-9][0-9A-Za-z.-]*)"?\s*$/m.exec(readFileSync(join(plugin, 'plugin.yaml'), 'utf8'))?.[1];
if (!version) throw new Error('hermes-plugin/plugin.yaml has no version');

mkdirSync(out, {recursive: true});
const staging = join(out, 'vela-im-hermes-plugin.tar.gz');
const pack = `set -euo pipefail
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u+rw,go+r,go-w \\
  --exclude=__pycache__ --exclude=tests --exclude='*.pyc' -C "$1" -cf - . | gzip -n -9 > "$2"`;
execFileSync('bash', ['-c', pack, 'package', plugin, staging], {stdio: 'inherit'});

const archive = readFileSync(staging);
const sha256 = createHash('sha256').update(archive).digest('hex');
const name = `vela-im-hermes-plugin-${version}-${sha256.slice(0, 12)}.tar.gz`;
renameSync(staging, join(out, name));
writeFileSync(join(out, `${name}.sha256`), `${sha256}  ${name}\n`);
console.log(JSON.stringify({file: `dist/${name}`, bytes: archive.length, sha256, cosKey: `vela-im/${name}`}, null, 2));
