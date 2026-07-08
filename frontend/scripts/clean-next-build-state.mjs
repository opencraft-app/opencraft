import { rmSync } from 'node:fs';
import { join } from 'node:path';

const frontendRoot = process.cwd();
const nextDir = join(frontendRoot, '.next');

rmSync(nextDir, { recursive: true, force: true });
console.log(`[clean-next-build-state] removed ${nextDir}`);
