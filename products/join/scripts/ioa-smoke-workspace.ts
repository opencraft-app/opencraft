import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../plugins/tencentoa/src/', import.meta.url));
// The probes deliberately render public core components with a private provider.
export const ioaSmokeRoots = [
  fileURLToPath(new URL('../../..', import.meta.url)),
  fileURLToPath(new URL('..', import.meta.url)),
];
export const ioaSmokeAliases = [
  { find: /^\/plugins\/tencentoa\/src\//, replacement: source },
  { find: /^@opencraft\/plugin-tencentoa\/contract$/, replacement: source + 'contract.ts' },
  { find: /^@opencraft\/plugin-tencentoa$/, replacement: source + 'index.ts' },
];
