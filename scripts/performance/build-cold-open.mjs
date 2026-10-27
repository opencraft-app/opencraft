import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headlessWebHostDefinitions } from '../package-headless-linux.mjs';

// Always build the current source. An existing dist or caller-supplied root
// cannot silently substitute a previously fast release into the formal gate.
const root = fileURLToPath(new URL('../../', import.meta.url));
await new Promise((resolve, reject) => {
  const child = spawn('npm', ['run', 'build:web:release'], {
    cwd: root, shell: false, stdio: 'inherit',
    env: { ...process.env, OPENCRAFT_HEADLESS_SERVER_BUILD: 'true', VITE_HYPERNODE_PLUGIN: 'disabled', OPENCRAFT_SPLIT_WEB_RESOURCES: '0', VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()) },
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`Cold-open build failed (${signal ?? code})`)));
});
