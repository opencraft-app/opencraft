import {conversationLink,type ConversationRef} from "@opencraft/appserver-protocol/collaboration";
import {serverUrl} from "./server-context";
import {writeTextToClipboard} from "@opencraft/chat-render-web/clipboard";
export async function copyConversationReference(request:(body:Record<string,unknown>)=>Promise<Record<string,unknown>>,base:string,target:{threadId:string;title:string}):Promise<void>{
  const result=await request({action:"reference",threadId:target.threadId});
  const deploymentBase=new URL(serverUrl("/"),base).href;
  await writeTextToClipboard(conversationLink(deploymentBase,result.ref as unknown as ConversationRef,target.title));
}
