import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import { CHANNEL_SEARCH_CONTRIBUTION } from './channel-search';
export type { ChannelSearchContribution } from './channel-search';
export { channelResource } from './channel-search';
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { createDeferredView } from "@opencraft/extension-react";
import { ImController } from "./client";
import type { ChannelRpc } from "./channel-client";
export type { ChannelRpc } from "./channel-client";
export { ImClient } from "./client";
export { sourceRoute, stewardRoute } from "./templates";
export const IM_SETTINGS_ID = "opencraft.im.channels";
export const CHANNEL_CHAT_VIEW_ID = "opencraft.im.channel-chat";
const channelDirectoryViewId = "opencraft.im.channel-directory";
const channelTitle = { id: "im.shadow.title", defaultMessage: "Chats" };
export function createImExtension(
  fetcher: typeof fetch,
  createChannelRpc?: (signal: AbortSignal) => ChannelRpc,
  nativeOnly = false,
): TrustedExtensionDefinition {
  return {
    manifest: {
      manifestVersion: 1,
      id: "opencraft.im",
      name: "IM channels",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    async activate(api) {
      if(!nativeOnly) {
      const controller = new ImController(fetcher);
      api.views.register({
        id: IM_SETTINGS_ID + ".view",
        title: "IM 渠道",
        viewType: IM_SETTINGS_ID,
        platforms: ["web", "electron"],
      });
      api.settings.registerPage({
        id: IM_SETTINGS_ID,
        title: "IM 渠道",
        viewId: IM_SETTINGS_ID + ".view",
        group: "Server",
        icon: "message-circle",
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: IM_SETTINGS_ID,
        Component: createDeferredView(async () =>
          (await import("./view")).createImView(controller),
        ),
      });
      api.subscriptions.add(() => controller.dispose());
      }
      const capabilities = nativeOnly ? {nativeChannels:true,channels:1,channelGroupTools:true,channelImages:false} : await fetcher("/__opencraft_im/capabilities", { signal: api.signal })
        .then(async response => response.ok ? await response.json() : null)
        .catch(() => null);
      if (capabilities?.nativeChannels !== true || api.signal.aborted) return;
      const channels = capabilities.channels === 1 ? createChannelRpc?.(api.signal) : undefined;
      if (!channels) return;
      if (channels) api.subscriptions.add(() => { void channels.close().catch(() => {}); });
      await channels.connect();
      if(api.signal.aborted)return;
      const peopleId='opencraft.im.people',peopleEntry=peopleId+'.entry',inboxType='opencraft.im.inbox';
      for(const id of [peopleId,peopleEntry])api.views.register({id,title:'Inbox',titleMessage:{id:'people.title',defaultMessage:'Inbox'},viewType:id===peopleId?inboxType:id,platforms:['web','electron'],keepConversationSidebar:true,...(id===peopleId?{routeFamily:peopleId}:{})});
      api.sidebar.registerCatalog({id:peopleId+'.catalog',title:'Inbox',titleMessage:{id:'people.title',defaultMessage:'Inbox'},viewId:peopleEntry,presentation:'entry',order:35});
      api.views.register({id:'opencraft.im.agents',title:'Assistants',titleMessage:{id:'agents.title',defaultMessage:'Assistants'},viewType:'opencraft.im.agents',platforms:['web','electron'],keepConversationSidebar:true});
      const {getChannelRuntime}=await import('./channel-runtime');
      const runtime=getChannelRuntime(fetcher,channels,api.signal);
      let peopleViews: Promise<ReturnType<typeof import('./people-view').createPeopleViews>> | undefined;
      const people=()=>peopleViews??=import('./people-view').then(m=>m.createPeopleViews(channels,api.signal,CHANNEL_CHAT_VIEW_ID,runtime));
      const groupTools = channels !== undefined && capabilities.channelGroupTools === true;
      let viewsPromise: Promise<ReturnType<typeof import("./channel-chat-view").createChannelChatViews>> | undefined;
      const views = () => (viewsPromise ??= import("./channel-chat-view").then(module =>
        module.createChannelChatViews(fetcher, channels.supportsAttachments === true, channels, CHANNEL_CHAT_VIEW_ID, api.signal, groupTools, api.storage, api.blobResources, runtime)));
      const Inbox = createDeferredView(async () => {
        const [module, directory, chat] = await Promise.all([import("./inbox-view"), people(), views()]);
        return module.createInboxView({ Directory: directory.Page, Conversation: chat.Conversation, chatViewId: CHANNEL_CHAT_VIEW_ID });
      });
      api.internal.register('platformViewRenderer',{viewType:peopleEntry,Component:createDeferredView(async()=>(await people()).Entry)});
      api.internal.register('platformViewRenderer',{viewType:inboxType,Component:Inbox});
      api.internal.register('platformViewRenderer',{viewType:'opencraft.im.agents',Component:createDeferredView(async()=>(await people()).AgentsPage)});
      if (api.signal.aborted) return;
      const searchClient=runtime.client;
      const removeSearch=api.internal.register(CHANNEL_SEARCH_CONTRIBUTION,{id:'native-channels',
        async search(query:string,before:number|undefined,requestSignal:AbortSignal){
          api.signal.throwIfAborted();
          const request=combineAbortSignals([api.signal,requestSignal]);
          try {const result=await searchClient.search(query,before,request.signal);request.signal.throwIfAborted();return result;}
          finally{request.dispose();}
        }});
      const retireSearch=()=>{void removeSearch?.();};runtime.signal.addEventListener('abort',retireSearch,{once:true});if(runtime.signal.aborted)retireSearch();

      for (const id of [CHANNEL_CHAT_VIEW_ID, channelDirectoryViewId]) api.views.register({
        id, title: channelTitle.defaultMessage, titleMessage: channelTitle, viewType: id === CHANNEL_CHAT_VIEW_ID ? inboxType : id, platforms: ["web", "electron"],
        ...(id === CHANNEL_CHAT_VIEW_ID ? { keepConversationSidebar: true, routeFamily: peopleId, navigationParent: { viewId: peopleId } } : {}),
      });

      api.internal.register("platformViewRenderer", {
        viewType: channelDirectoryViewId,
        Component: createDeferredView(async () => (await views()).Directory),
      });

    },
  };
}
