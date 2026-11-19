import { PersonalGitEnvironment } from '../../scripts/personal-git.js';
import type { CapabilitySession, SessionCapabilityProvider } from '../../packages/session-capabilities/src/index.js';

/** Metadata comes from the current admitted input, never from model arguments or
 * machine Git configuration. This tool does not require a Gongfeng MCP token. */
export function personalGitCapability(directory: string, machineId: string): { provider: SessionCapabilityProvider; close(): Promise<void> } | undefined {
  const owner = PersonalGitEnvironment.fromEnvironment(directory);
  if (!owner) return undefined;
  const scope = (session: CapabilitySession) => {
    const hostId = session.serverId === `server:${machineId}:codex` ? 'local-codex'
      : [`server:${machineId}:dsh`, `server:${machineId}:pi`].includes(session.serverId) ? 'opencraft-server' : null;
    return hostId && session.execution && (session.execution.inputId || session.execution.turnId)
      ? { hostId, threadId: session.threadId, ...session.execution } : null;
  };
  return {
    provider: {
      id: 'personal-git',
      tools(session) { return scope(session) ? [{ name: 'git_identity_status', approval: 'preauthorized',
        description: '核对本轮真实身份及平台个人 Git SSH 绑定。Git 通过普通 git 命令使用平台托管 SSH，无需工蜂 MCP Token。缺少 MCP 工具不代表 SSH 未绑定；不要改用仓库遗留私钥或共享账号。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] : []; },
      async call(session, name, args, signal) {
        if (name !== 'git_identity_status' || signal.aborted || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Error('invalid_git_status_request');
        const current = scope(session); if (!current) throw Error('personal_git_execution_unavailable');
        return owner.status(current);
      },
    },
    close: () => owner.close(),
  };
}
