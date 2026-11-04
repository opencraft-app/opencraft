import type { ConversationServer } from '@opencraft/appserver-protocol/collaboration';
import { CliError, classify } from './errors';

/** Resolve only the current connection's already-authorized directory. */
export function selectServer(servers: ConversationServer[], selector?: string): ConversationServer {
  const exact = selector === undefined ? undefined : servers.find(server => server.serverId === selector);
  if (exact) return exact;
  const candidates = selector === undefined ? servers : servers.filter(server => server.engine === selector || server.label === selector);
  if (candidates.length === 1) return candidates[0]!;
  const ids = (candidates.length ? candidates : servers).map(server => server.serverId);
  const message = candidates.length === 0 ? 'Server not found in this connection.' : 'Server selection is ambiguous.';
  throw new CliError(candidates.length === 0 ? 3 : 5, candidates.length === 0 ? 'UNKNOWN_SERVER' : 'AMBIGUOUS_SERVER',
    message + ' Candidates: ' + (ids.join(', ') || '(none)')
      + '. Use --server <full-id> or connection add <new-name> --ssh <alias> --default-server <full-id>.',
    false, { servers: ids });
}

/** Keep capability failures actionable using only the authorized directory. */
export function unsupported(servers: ConversationServer[], server: ConversationServer, command: string, capability: keyof ConversationServer['capabilities']) {
  const alternatives = servers.filter(row => row.serverId !== server.serverId && row.capabilities[capability] === true).map(row => ({serverId:row.serverId,label:row.label,engine:row.engine}));
  return new CliError(6,'UNSUPPORTED_CAPABILITY',
    `${command} is not supported by Server ${server.serverId} (${server.label}, ${server.engine}); missing ${capability}. ` +
    (alternatives.length ? `Use --server ${alternatives.map(row=>row.serverId).join(' or --server ')}.` : 'No compatible Server is advertised in this connection. Check server list or update the service.'), false,
    {command,serverId:server.serverId,label:server.label,engine:server.engine,capability,alternatives});
}
export async function acrossServers<T extends {nextCursor:string|null}>(servers: ConversationServer[], read: (server:ConversationServer)=>Promise<T>) {
  const results = [];
  for (const server of servers) {
    try { results.push({serverId:server.serverId,label:server.label,engine:server.engine,ok:true as const,data:await read(server)}); }
    catch(error) {
      const fault=classify(error);
      if (['AUTH_REQUIRED','FORBIDDEN'].includes(fault.code)) throw fault;
      results.push({serverId:server.serverId,label:server.label,engine:server.engine,ok:false as const,error:{code:fault.code,message:fault.message,retryable:fault.retryable,...(fault.details===undefined?{}:{details:fault.details})}});
    }
  }
  return {scope:'all-visible-servers' as const,results,partial:results.some(row=>!row.ok),complete:results.every(row=>row.ok && row.data.nextCursor===null)};
}
