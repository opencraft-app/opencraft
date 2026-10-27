/** npm <=11 returns an array; npm 12 keys results by package name. */
export function parseNpmPackResult(value) {
  const entries = Array.isArray(value) ? value
    : value && typeof value === 'object' ? Object.values(value) : [];
  if (entries.length !== 1 || !entries[0] || typeof entries[0].filename !== 'string'
    || !/^[A-Za-z0-9._-]+\.tgz$/.test(entries[0].filename)) throw new Error('Invalid npm archive');
  return entries[0];
}
