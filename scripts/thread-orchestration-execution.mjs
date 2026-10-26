import { randomUUID } from 'node:crypto';
import { callConversationHost } from './conversation-execution.mjs';

export function driverForThread(threadId) {
  if (threadId.startsWith('pi_')) return 'pi';
  if (threadId.startsWith('dsh_acp_')) return 'dsh-acp';
  if (threadId.startsWith('claude_')) return 'claude-code';
  if (threadId.startsWith('acp_')) return 'acp';
  return 'codex';
}

/** @returns {import('../packages/appserver-client/src/agent-driver.ts').AgentDriverContract} */
export function createThreadOrchestrationExecution(getAppHost, { prepared = () => null, enabled = ['codex'] } = {}) {
  const target = driver => driver === 'dsh' ? 'dsh-acp' : driver;
  const requireDriver = driver => {
    if (!enabled.includes(driver)) throw Object.assign(new Error('Orchestration driver is unavailable'), { status: 400, code: 'orchestration_driver_unsupported' });
    return driver;
  };
  const invoke = (driver, method, threadId, operationId, params = {}, canAdmit = () => true) => {
    requireDriver(driver);
    const host = getAppHost(); if (!host) throw new Error('Orchestration Host unavailable');
    return callConversationHost(host, { hostId: driver === 'codex' ? 'local-codex' : 'opencraft-server', threadId }, operationId,
      method, { operationId, ...(driver === 'codex' ? {} : { driver }), ...params },
      { sender: null, orchestrationOperationId: operationId, orchestrationCanAdmit: canAdmit });
  };
  return {
    async prepare(operationId, threadId, args, canAdmit, callbackIncarnation) {
      const source = driverForThread(threadId), destination = requireDriver(target(args.driver ?? source));
      if (destination === source) return { ...await invoke(source, 'opencraft/orchestration/prepare', threadId, operationId,
        { arguments: args, callbackIncarnation }, canAdmit), orchestrationDriver: destination };
      const sourceSettings = await invoke(source, 'opencraft/orchestration/prepare', threadId, operationId,
        { arguments: { ...(args.cwd === undefined ? {} : { cwd: args.cwd }) }, callbackIncarnation, sourceOnly: true }, canAdmit);
      if (!canAdmit()) throw Object.assign(new Error('Orchestration delegation revoked'), { status: 403 });
      return { ...await invoke(destination, 'opencraft/orchestration/prepare', threadId, operationId,
        { arguments: { ...args, cwd: sourceSettings.cwd }, sourceSettings }, canAdmit), orchestrationDriver: destination };
    },
    create: (operationId, threadId, settings, canAdmit) => invoke(settings.orchestrationDriver ?? target(settings.driver ?? 'codex'),
      'opencraft/orchestration/create', threadId, operationId, { settings }, canAdmit),
    acknowledge: async operationId => {
      const settings = prepared(operationId);
      return (await invoke(settings?.orchestrationDriver ?? target(settings?.driver ?? 'codex'), 'opencraft/orchestration/ack', '', operationId)).acknowledged === true;
    },
    snapshot: threadId => invoke(driverForThread(threadId), 'opencraft/orchestration/status', threadId, `status:${randomUUID()}`),
    inspect: (threadId, limit) => invoke(driverForThread(threadId), 'opencraft/orchestration/inspect', threadId, `inspect:${randomUUID()}`, { limit }),
  };
}
