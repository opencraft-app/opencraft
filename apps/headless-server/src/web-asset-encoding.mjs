import { stat } from 'node:fs/promises';

// Never compress per request. Sidecars are produced once by the build and are
// selected only for immutable assets, with the original resource's MIME/cache.
export async function selectAssetEncoding(path, acceptEncoding = '') {
  const weights = new Map();
  for (const item of String(acceptEncoding).split(',')) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';');
    if (!name) continue;
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    weights.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  const weight = name => weights.get(name) ?? weights.get('*') ?? (name === 'identity' ? 1 : 0);
  const candidates = [['br', '.br'], ['gzip', '.gz']]
    .map(([encoding, suffix]) => ({ encoding, path: path + suffix, q: weight(encoding) }))
    .filter(item => item.q > 0 && item.q >= (weights.get('identity') ?? 0))
    .sort((a, b) => b.q - a.q);
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate.path);
      if (metadata.isFile()) return { ...candidate, metadata };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (weight('identity') === 0) return null;
  return { encoding: null, path, metadata: await stat(path) };
}
