import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headlessWebBuildEnvironment } from '../packaging/headless-web-build.mjs';

// Always build the current source. An existing dist or caller-supplied root
// cannot silently substitute a previously fast release into the formal gate.
const root = fileURLToPath(new URL('../../', import.meta.url));
await new Promise((resolve, reject) => {
  const child = spawn('npm', ['run', 'build:web:release'], {
    cwd: root, shell: false, stdio: 'inherit',
    env: { ...process.env, ...headlessWebBuildEnvironment(), OPENCRAFT_SPLIT_WEB_RESOURCES: '0' },
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`Cold-open build failed (${signal ?? code})`)));
});
