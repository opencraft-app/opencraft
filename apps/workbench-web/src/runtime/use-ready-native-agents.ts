import {useCallback,useSyncExternalStore} from 'react';
import {useQueries} from '@tanstack/react-query';
import {useAppServerHosts} from './appserver-runtime-context';
import {readReadyNativeAgents} from './ready-native-agents';
export function useReadyNativeAgents(enabled:boolean,activeHostId:string,isEnabled:(hostId:string,agentId:string)=>boolean) {
 const hosts=useAppServerHosts();
 const account=useSyncExternalStore(hosts.threadAttention.subscribe,()=>hosts.threadAttention.getScope()??'anonymous');
 const display=useSyncExternalStore(hosts.displayContinuity.subscribe,hosts.displayContinuity.getScope);
 const profiles=hosts.profiles.filter(profile=>profile.enabled&&profile.hideFromNewChat!==true&&(profile.hostId===activeHostId||profile.machinePresence==='online'));
 const request=useCallback<typeof hosts.agentRuntimes.request>((hostId,method,params)=>hosts.agentRuntimes.request(hostId,method,params),[hosts.agentRuntimes]);
 const queries=useQueries({queries:profiles.map(profile=>({queryKey:['ready-native-agents',account,display,profile.hostId,profile.revision],enabled,retry:false,staleTime:30000,
  queryFn:({signal}:{signal:AbortSignal})=>readReadyNativeAgents(request,profile.hostId,signal)}))});
 return {failed:enabled&&queries.some(query=>query.isError),retry:()=>{void Promise.all(queries.map(query=>query.refetch()));},checking:enabled&&queries.some(query=>query.isFetching),choices:!enabled?[]:profiles.flatMap((profile,index)=>(queries[index]?.data??[]).filter(agent=>isEnabled(profile.hostId,agent.agentId)).map(agent=>({...agent,hostId:profile.hostId,hostName:profile.machineIdentity?.name??profile.displayName})))};
}
