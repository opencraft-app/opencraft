import { startHandsExecutionOwner } from '@opencraft/sandbox-node/hands-unix';
import { handsResources } from './resources.mjs';
import { mkdir } from 'node:fs/promises';
import { deploymentPaths } from './paths.mjs';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const tokenFile = required('OPENCRAFT_HANDS_EXECUTION_TOKEN');
const projectlessWorkspace = deploymentPaths().codexProjectlessDirectory;
await mkdir(projectlessWorkspace, { recursive: true, mode: 0o700 });
const owner = await startHandsExecutionOwner({
  endpoint: required('OPENCRAFT_HANDS_EXECUTION_SOCKET'),
  tokenFile,
  executable: required('OPENCRAFT_CODEX_EXECUTABLE'),
  workspace: required('OPENCRAFT_WORKSPACE_DIR'),
  projectlessWorkspace,
  resources: handsResources(),
  verifyCgroup: true,
});
const stop = () => void owner.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
console.log(JSON.stringify({ type: 'opencraft-hands-execution-ready', pid: process.pid }));
