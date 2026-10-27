import {conversationLink,type ConversationRef} from "@opencraft/appserver-protocol/collaboration";
import {writeTextToClipboard} from "@opencraft/chat-render-web/clipboard";
export async function copyConversationReference(request:(body:Record<string,unknown>)=>Promise<Record<string,unknown>>,base:string,target:{threadId:string;title:string}):Promise<void>{
  const result=await request({action:"reference",threadId:target.threadId});
  const link=new URL(conversationLink(base,result.ref as unknown as ConversationRef));link.searchParams.set("title",target.title);
  await writeTextToClipboard(link.href);
}
