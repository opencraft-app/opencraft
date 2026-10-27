// Use npm's credential/transport implementation, without pack or tar parsing.
import { open, realpath, rm, access } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';


export function internalTarballUrl(value, registryUrl) {
  const origin = new URL(value), registry = new URL(registryUrl);
  if (origin.protocol !== 'https:' || origin.origin !== registry.origin || !origin.pathname.startsWith(registry.pathname)
    || origin.username || origin.password || origin.search || origin.hash) throw new Error('Candidate archive origin rejected');
  return origin.href;
}

export async function downloadCandidate(spec, fetch) {
  const url = internalTarballUrl(spec.url, spec.registry);
  const maximum = spec.compressedBytes ?? spec.archiveBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 ** 3
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(spec.integrity)) throw new Error('Invalid candidate download budget');
  const response = await fetch(url);
  let file;
  try {
    // Every redirect is refused, including redirects to the same registry.
    if (response.status !== 200 || new URL(response.url).href !== url) throw new Error('Candidate redirect or HTTP status rejected');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || (Number(length) > maximum || (spec.compressedBytes !== undefined && Number(length) !== spec.compressedBytes)))) throw new Error('Candidate content length mismatch');
    file = await open(spec.destination, 'wx', 0o600);
    let bytes = 0; const hash = createHash('sha512');
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error('Candidate compressed stream budget exceeded');
      hash.update(chunk); await file.writeFile(chunk);
    }
    if ((spec.compressedBytes !== undefined && bytes !== spec.compressedBytes) || 'sha512-' + hash.digest('base64') !== spec.integrity) throw new Error('Candidate downloaded bytes mismatch');
    await file.sync(); await file.close(); file = null;
    return { status: 'downloaded', registry: spec.registry, tarball: url, redirects: 0, compressedBytes: bytes, integrity: spec.integrity };
  } catch (error) {
    if (file) { await file.close(); await rm(spec.destination, { force: true }); }
    throw error;
  } finally { response.body?.destroy?.(); }
}

export async function npmTransport(spec) {
  let selected = spec.npmCli;
  if (!selected) {
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      const candidate = join(directory, 'npm');
      try { await access(candidate, constants.X_OK); selected = candidate; break; }
      catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
    }
  }
  if (!selected) throw new Error('npm toolchain is unavailable');
  const npmCli = await realpath(selected), require = createRequire(npmCli);
  const Config = require('@npmcli/config');
  const { definitions, flatten, nerfDarts, shorthands } = require('@npmcli/config/lib/definitions');
  const scope = spec.packageName?.startsWith('@') ? spec.packageName.split('/')[0] : null;
  const config = new Config({ npmPath: dirname(dirname(npmCli)), definitions, flatten, nerfDarts, shorthands, warn: false,
    argv: [process.execPath, npmCli, '--registry=' + spec.registry, ...(scope ? ['--' + scope + ':registry=' + spec.registry] : []), ...(spec.userconfig ? ['--userconfig=' + spec.userconfig] : [])] });
  await config.load();
  const url = internalTarballUrl(spec.url, spec.registry), opts = config.flat;
  const auth = require('npm-registry-fetch/lib/auth.js')(url, opts);
  const headers = { 'accept-encoding': 'identity' };
  if (auth.token) headers.authorization = 'Bearer ' + auth.token;
  else if (auth.auth) headers.authorization = 'Basic ' + auth.auth;
  const fetch = require('make-fetch-happen');
  return (requested, { method = 'GET', body, headers: requestHeaders = {} } = {}) => {
    const normalized = Object.fromEntries(Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), value]));
    return fetch(internalTarballUrl(requested, spec.registry), { ...opts, method, body,
      headers: { ...normalized, ...headers }, cert: auth.cert || opts.cert, key: auth.key || opts.key,
      proxy: opts.httpsProxy || opts.proxy, noProxy: opts.noProxy, strictSSL: opts.strictSSL,
      redirect: 'manual', cache: 'no-store', retry: 0, compress: false, timeout: 300000 });
  };
}

export async function downloadNpmArchive(spec) {
  try { return await downloadCandidate(spec, await npmTransport(spec)); }
  catch { throw new Error('Signed release stream download failed'); }
}
