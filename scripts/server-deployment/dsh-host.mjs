import { mkdir, rename, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLocalAgentStorageOwner, startLocalAgentHost } from '../../apps/local-agent-host/src/main.ts';
import { readDaemonMachineIdentity } from '../../apps/opencraft-daemon/src/machine-identity.ts';
import { readPrivateJson } from './dsh-host-client.mjs';
import { readTaskCoreConversations } from '../tasks-conversation-catalog.mjs';
import { RemoteSessionCapabilities } from '../../packages/session-capabilities/src/remote.ts';

export async function startIndependentDshHost({ descriptorPath, machineIdentityDirectory, machineName, taskCodexCoreEndpoint, taskCodexCoreTokenFile, ...options }) {
  if (!isAbsolute(descriptorPath) || !isAbsolute(options.dataDirectory ?? ''))
    throw new Error('Independent DSH Host requires absolute descriptor and data paths');
  if (process.env.OPENCRAFT_DSH_URL?.trim() || options.dshUrl)
    throw new Error('Independent DSH Host must own its engine');
  const release = await acquireLocalAgentStorageOwner(options.dataDirectory);
  let agent;
  let closed;
  const temporary = `${descriptorPath}.${randomUUID()}.tmp`;
  try {
    const machineIdentity = options.machineIdentity ?? await readDaemonMachineIdentity(
      machineIdentityDirectory ?? dirname(options.dataDirectory), machineName);
    options.machineIdentity = machineIdentity;
    const sessionCapabilities = new RemoteSessionCapabilities(dirname(options.dataDirectory), `server:${machineIdentity.machineId}:dsh`);
    options.sessionCapabilities ??= sessionCapabilities;
    options.authorizeHostInput ??= (threadId, inputId) => sessionCapabilities.authorizeInput(threadId, inputId);
    options.taskServerId ??= "opencraft-server";
    options.taskSkillDirectories ??= [resolve(options.dataDirectory, "../codex/runtime/skills")];
    if (taskCodexCoreEndpoint || taskCodexCoreTokenFile) {
      if (!isAbsolute(taskCodexCoreEndpoint ?? '') || !isAbsolute(taskCodexCoreTokenFile ?? '')) throw new Error('Task Core catalog requires explicit absolute connection paths');
      const info = await stat(taskCodexCoreTokenFile);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Task Core catalog requires an owned private token file');
      const token = (await readFile(taskCodexCoreTokenFile, 'utf8')).trim();
      if (!token) throw new Error('Task Core catalog token is empty');
      options.taskConversationCatalog ??= (serverId, search, limit, cursor) => {
        if (serverId !== 'local-codex') throw new Error('Unknown task conversation server');
        return readTaskCoreConversations(taskCodexCoreEndpoint, token, search, limit, cursor);
      };
    }
    agent = await startLocalAgentHost(options);
    await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, machineId: machineIdentity.machineId,
      dataDirectory: resolve(options.dataDirectory), websocketUrl: agent.websocketUrl }), { mode: 0o600 });
    await rename(temporary, descriptorPath);
    return { ...agent,
      get engineProcessId() { return agent.engineProcessId; },
      get engineState() { return agent.engineState; },
      get dshUrl() { return agent.dshUrl; },
      close() {
        return closed ??= (async () => {
          try { await agent.close(); }
          finally { await rm(descriptorPath, { force: true }); await release(); }
        })();
      } };
  } catch (error) {
    await rm(temporary, { force: true });
    try { await agent?.close(); } finally { await release(); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = await readPrivateJson(process.env.OPENCRAFT_DSH_HOST_CONFIG ?? '');
  const host = await startIndependentDshHost({
    ...config,
    taskCodexCoreEndpoint: config.taskCodexCoreEndpoint ?? process.env.OPENCRAFT_CODEX_CORE_ENDPOINT,
    taskCodexCoreTokenFile: config.taskCodexCoreTokenFile ?? process.env.OPENCRAFT_DAEMON_TOKEN_FILE,
  });
  console.log('Independent OpenCraft DSH Host ready');
  const stop = () => void host.close().then(() => process.exit(0), () => process.exit(1));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
