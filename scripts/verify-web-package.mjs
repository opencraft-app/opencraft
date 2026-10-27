#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export async function verifyWebPackage(packageRoot) {
  const root = resolve(packageRoot);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const web = JSON.parse(await readFile(join(root, 'web/version.json'), 'utf8'));
  if (manifest.opencraftExecution || manifest.opencraftWeb?.resources || web.headlessServer === true)
    throw new Error('Expected a self-contained website package without execution payload');
  const state = await mkdtemp(join(tmpdir(), 'opencraft-web-package-'));
  const child = spawn(process.execPath, [join(root, 'runtime/cli.mjs')], {
    env: { PATH: process.env.PATH, OPENCRAFT_WEB_STATE: state, OPENCRAFT_WEB_PORT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  try {
    const base = await new Promise((accept, reject) => {
      const timeout = setTimeout(() => finish(new Error('Website package startup timed out')), 20_000);
      const onError = () => finish(new Error('Website package could not start'));
      const onExit = () => finish(new Error('Website package exited before readiness'));
      let output = '';
      const onData = data => {
        output += data;
        const match = output.match(/\[opencraft web\] (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) finish(null, match[1]);
      };
      function finish(error, value) {
        clearTimeout(timeout); child.off('error', onError); child.off('exit', onExit); child.stdout.off('data', onData);
        error ? reject(error) : accept(value);
      }
      child.once('error', onError); child.once('exit', onExit); child.stdout.on('data', onData);
    });
    const get = async path => {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Website package HTTP verification failed');
      return response;
    };
    const live = await (await get('/version.json')).json();
    const status = await (await get('/__opencraft_updates')).json();
    await get('/'); await get('/__opencraft_health');
    if (live.buildId !== manifest.opencraftWeb?.buildId || status.current.version !== manifest.version
      || status.packageName !== manifest.name || status.execution !== null)
      throw new Error('Website package runtime identity mismatch');
    return { version: manifest.version, buildId: live.buildId, sourceRevision: live.sourceRevision, profile: 'web', ready: true };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill('SIGTERM');
      await exited.finally(() => clearTimeout(timer));
    }
    await rm(state, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: verify-web-package.mjs /packaged/website');
  console.log(JSON.stringify(await verifyWebPackage(process.argv[2])));
}
