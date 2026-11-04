import { startHandsExecutionOwner } from '@opencraft/sandbox-node/hands-unix';

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
  resources: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
  verifyCgroup: true,
});
const stop = () => void owner.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
console.log(JSON.stringify({ type: 'opencraft-hands-execution-ready', pid: process.pid }));
