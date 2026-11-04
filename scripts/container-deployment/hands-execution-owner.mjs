import { startHandsExecutionOwner } from '@opencraft/sandbox-node/hands-unix';
import { handsResources } from './resources.mjs';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const owner = await startHandsExecutionOwner({
  endpoint: required('OPENCRAFT_HANDS_EXECUTION_SOCKET'),
  tokenFile: required('OPENCRAFT_HANDS_EXECUTION_TOKEN'),
  executable: required('OPENCRAFT_CODEX_EXECUTABLE'),
  workspace: required('OPENCRAFT_WORKSPACE_DIR'),
  resources: handsResources(),
  verifyCgroup: true,
});
const stop = () => void owner.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
console.log(JSON.stringify({ type: 'opencraft-hands-execution-ready', pid: process.pid }));
