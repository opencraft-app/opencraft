import {statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Node may silently ignore a missing explicit test filename. Validate the owned
// manifest before launching so a rename cannot make this recovery gate false-green.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'tests/protocol/appserver-client.test.ts',
  'tests/protocol/appserver-send-progress.test.ts',
  'tests/protocol/appserver-websocket-transport.test.ts',
  'tests/protocol/websocket-send-progress.test.ts',
  'tests/protocol/client-native-retirement.test.ts',
  'tests/protocol/client-retirement-chaos.test.ts',
  'tests/composer/opencraft-composer-attachment-preview.test.ts',
  'tests/resources/chunked-attachment-upload.test.ts',
  'tests/resources/runtime-attachment-reconnect.test.ts',
  'tests/resources/web-attachment-upload.test.ts',
  'tests/resources/attachment-upload-ownership.test.ts',
  'tests/resources/attachment-orphan-cleanup.test.ts',
  'tests/resources/attachment-chunk-deadline-native.test.mjs',
];
for (const file of files) {
  if (!statSync(new URL('../' + file, import.meta.url)).isFile()) throw new Error('Missing attachment regression: ' + file);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
