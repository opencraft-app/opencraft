import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SERVER_SPACES_METHOD, type ServerSpaceCommand, type ServerSpaceDirectory, type ServerSpaceMember } from '@opencraft/appserver-protocol/server-spaces';
import { useUiPreferencesRuntime } from './ui-preferences-runtime';
import { useAppServerHosts } from './appserver-runtime-context';
import type { SidebarThread } from '../components/sidebar';

function directory(value: unknown): ServerSpaceDirectory {
  const d=value as ServerSpaceDirectory;
  if(!d||!Array.isArray(d.spaces)||!Array.isArray(d.assignments)||typeof d.actorId!=='string'
    ||d.spaces.some(s=>typeof s.id!=='string'||typeof s.name!=='string'||!['owner','member'].includes(s.role)||!Number.isSafeInteger(s.memberCount))
    ||d.assignments.some(a=>typeof a.engineServerId!=='string'||typeof a.threadId!=='string'||typeof a.spaceId!=='string'))throw new Error('Invalid server directory');
  return d;
}
export function useServerSpaces(hostId:string) {
  const queryClient=useQueryClient();
  const {agentRuntimes,threadAttention}=useAppServerHosts();
  const scope=useSyncExternalStore(threadAttention.subscribe,()=>threadAttention.getScope()??"anonymous");
  const subscribe=useCallback((f:()=>void)=>agentRuntimes.subscribe(hostId,f),[agentRuntimes,hostId]);
  const phase=useSyncExternalStore(subscribe,()=>agentRuntimes.getSnapshot(hostId).phase);
  const preferences=useUiPreferencesRuntime();
  const stored=useSyncExternalStore(preferences.subscribe,preferences.getSnapshot);
  const preferenceKey=JSON.stringify([hostId,scope]);
  const remembered=stored.values['sidebar.collaborationServers'][preferenceKey]??'myself';
  const [selection,setSelection]=useState({hostId,scope,spaceId:remembered});
  const selected=selection.hostId===hostId&&selection.scope===scope?selection.spaceId:remembered;
  const generation=useRef(0);
  const ownerKey=JSON.stringify([hostId,scope]);
  const host=useRef(ownerKey);host.current=ownerKey;
  const request=useCallback((command:ServerSpaceCommand)=>agentRuntimes.request(hostId,SERVER_SPACES_METHOD,command),[agentRuntimes,hostId]);
  const query=useQuery({queryKey:['server-spaces',hostId,scope],queryFn:async()=>directory(await request({action:'list'})),
    enabled:phase==='ready',retry:false,refetchInterval:5000});
  useEffect(()=>{generation.current++;return()=>{generation.current++;queryClient.removeQueries({queryKey:["server-spaces",hostId,scope],exact:true});};},[ownerKey,queryClient,hostId,scope]);
  useEffect(()=>{setSelection(previous=>previous.hostId===hostId&&previous.scope===scope?previous:{hostId,scope,spaceId:preferences.get("sidebar.collaborationServers")[preferenceKey]??"myself"});},[hostId,scope,preferences,preferenceKey]);
  const select=useCallback(async(spaceId:string,expectedGeneration?:number)=>{
    if(expectedGeneration!==undefined&&generation.current!==expectedGeneration)return false;
    const intent=++generation.current;
    await request({action:'select',spaceId});
    if(host.current!==ownerKey||generation.current!==intent)return false;
    setSelection({hostId,scope,spaceId});
    void preferences.update("sidebar.collaborationServers",current=>current[preferenceKey]===spaceId?current:({...current,[preferenceKey]:spaceId})).catch(()=>{});return true;
  },[hostId,scope,ownerKey,request,preferences,preferenceKey]);
  useEffect(()=>{
    if(phase==='ready'&&query.data?.spaces.some(s=>s.id===selected))void request({action:'select',spaceId:selected}).catch(()=>{});
  },[phase,hostId,selected,request,Boolean(query.data)]);
  useEffect(()=>{
    if(query.data&&!query.data.spaces.some(s=>s.id===selected))setSelection({hostId,scope,spaceId:query.data.spaces[0]?.id??'myself'});
  },[query.data,selected,hostId,scope]);
  const command=useCallback(async(value:ServerSpaceCommand)=>{
    const result=await request(value);await query.refetch();return result;
  },[request,query.refetch]);
  const filter=useCallback((threads:readonly SidebarThread[])=>{
    if(!query.data)return threads;
    const assignments=query.data.assignments;
    return threads.filter(thread=>{
      const assignment=assignments.find(a=>a.threadId===thread.id&&(a.engineServerId===thread.serverOrigin.serverId||a.engineServerId===thread.connectionHostId||a.engineServerId==='local'&&thread.connectionHostId===hostId));
      return (assignment?.spaceId??'myself')===selected;
    });
  },[query.data,selected,hostId,scope]);
  return {hostId,ownerKey,selectionGeneration:()=>generation.current,directory:query.data,selected,select,command,filter,refresh:query.refetch,
    loading:query.isPending,error:query.error,unavailable:(query.error as {code?:number}|null)?.code===-32601,
    async members(spaceId:string):Promise<ServerSpaceMember[]> {
      const result=await request({action:'members',spaceId}) as {members:ServerSpaceMember[]};
      if(!Array.isArray(result.members)||result.members.some(m=>typeof m.actorId!=='string'||typeof m.displayName!=='string'||!['owner','member'].includes(m.role)))throw new Error('Invalid members');
      return result.members;
    }};
}
export type ServerSpacesController=ReturnType<typeof useServerSpaces>;
