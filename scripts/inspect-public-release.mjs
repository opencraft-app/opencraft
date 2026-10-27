import { mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unpackRelease, PACKAGE_NAME } from './web-deployment/releases.mjs';

export async function inspectPublicRelease(archive) {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-public-release-'));
  try {
    const release = await unpackRelease(archive, directory);
    const manifest = JSON.parse(await readFile(join(release.releaseRoot, 'package.json'), 'utf8'));
    if (manifest.name !== PACKAGE_NAME || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/'
      || manifest.publishConfig?.access !== 'public' || !manifest.opencraftExecution)
      throw new Error('Expected public OpenCraft execution package');
    const metadata = manifest.opencraftExecution;
    if (metadata.platform !== 'linux' || metadata.arch !== 'x64' || metadata.nodeAbi !== '137')
      throw new Error('First public release supports Linux x64 / Node 24 only');
    if (!manifest.os?.includes('linux') || !manifest.cpu?.includes('x64') || manifest.engines?.node !== '>=24 <25')
      throw new Error('npm installation constraints do not match native payload');
    const forbidden = /(^|\/)(\.npmrc|\.env(?:\..*)?|admin-key|daemon\.token|\.git|\.local|\.runtime|credentials\.json|auth\.json)$|\.(?:map|pem|key)$/;
    const secrets = /npm_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
    let files = 0;
    async function walk(root, prefix = '') {
      for (const name of await readdir(root)) {
        const relative = prefix + name;
        if (forbidden.test(relative)) throw new Error(`Private or debug file in archive: ${relative}`);
        const file = join(root, name); const info = await lstat(file);
        if (info.isDirectory()) await walk(file, relative + '/');
        else {
          files++;
          if (/\.(?:mjs|cjs|js|json|md|service)$/.test(name) && secrets.test(await readFile(file, 'utf8')))
            throw new Error(`Credential pattern in archive: ${relative}`);
        }
      }
    }
    await walk(release.releaseRoot);
    // Exercise the shipped native runtime, not only its declared Node ABI.
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', `
      const pty = require('./execution/native/node-pty');
      const terminal = pty.spawn('/bin/sh', ['-c', 'printf opencraft-pty-ok'], { cwd: process.cwd(), cols: 80, rows: 24 });
      let output = '';
      terminal.onData(data => output += data);
      terminal.onExit(({ exitCode }) => { if (exitCode !== 0 || !output.includes('opencraft-pty-ok')) process.exitCode = 1; else console.log('pty-ok'); });
    `], { cwd: release.releaseRoot, env: { PATH: process.env.PATH, HOME: directory }, timeout: 10_000 });
    if (stdout.trim() !== 'pty-ok') throw new Error('Packaged PTY smoke failed');
    return { ...release, packageName: manifest.name, execution: metadata, files };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/inspect-public-release.mjs archive.tgz');
  console.log(JSON.stringify(await inspectPublicRelease(process.argv[2]), null, 2));
}
