import * as vscode from 'vscode';
import WebSocket from 'ws';
import {readFile,stat} from 'node:fs/promises';
import {isAbsolute,basename,join} from 'node:path';
import {NativeCodeBuddyAdapter} from './native-adapter.mjs';
let closed=false,socket,timer,connecting=false,context,descriptorPath,output;
const adapter=new NativeCodeBuddyAdapter(vscode.commands,()=>vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??null,()=>vscode.workspace.isTrusted);
function schedule(){clearTimeout(timer);if(!closed)timer=setTimeout(()=>void connect(),3000);}
async function descriptor(path){
  if(!isAbsolute(path)||basename(path)!=='codebuddy-ide-bridge.json')throw new Error('Invalid OpenCraft connection file');
  const info=await stat(path);
  if(!info.isFile()||info.size>4096||process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid()))throw new Error('OpenCraft connection file must be private to this user');
  const data=JSON.parse(await readFile(path,'utf8'));const url=new URL(data.url);
  if(data.version!==1||url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.pathname!=='/ide'||typeof data.ideToken!=='string'||!/^[a-f0-9]{64}$/.test(data.ideToken))throw new Error('Invalid OpenCraft connection data');
  return data;
}
async function connect(){
  if(closed||connecting||socket?.readyState===WebSocket.OPEN||!descriptorPath)return;
  connecting=true;
  try{
    const data=await descriptor(descriptorPath);if(closed)return;
    const ws=new WebSocket(data.url,{headers:{authorization:'Bearer '+data.ideToken},maxPayload:2*1024*1024});socket=ws;
    ws.on('open',()=>{
      output?.appendLine('Local OpenCraft transport connected.');
      let projectionTimer,lastProjection;
      const project=async()=>{try{const status=await adapter.describe();if(closed||socket!==ws||ws.readyState!==WebSocket.OPEN)return;
        const next=JSON.stringify(status);if(next!==lastProjection){ws.send(JSON.stringify({kind:'hello',version:1,status}));lastProjection=next;}
      }catch{output?.appendLine('Native CodeBuddy command interface is not ready.');ws.close();}
      finally{if(!closed&&socket===ws&&ws.readyState===WebSocket.OPEN)projectionTimer=setTimeout(()=>void project(),2500);}};
      ws.once('close',()=>clearTimeout(projectionTimer));void project();
    });
    ws.on('message',bytes=>{void (async()=>{
      let request;try{request=JSON.parse(String(bytes));if(request?.kind!=='request'||typeof request.id!=='string')return;
        const result=await adapter.call(request.method,request.params);if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({kind:'response',id:request.id,result}));
      }catch{if(ws.readyState===WebSocket.OPEN&&request?.id)ws.send(JSON.stringify({kind:'response',id:request.id,error:'CodeBuddy IDE could not confirm this operation. Check the native conversation.'}));}
    })();});
    ws.on('error',()=>{});ws.once('close',()=>{if(socket===ws)socket=undefined;schedule();});
  }catch{schedule();}finally{connecting=false;}
}
export async function activate(value){
  closed=false;context=value;output=vscode.window.createOutputChannel('OpenCraft CodeBuddy IDE');value.subscriptions.push(output);descriptorPath=value.globalState.get('descriptor');
  if(!descriptorPath)try{const hint=JSON.parse(await readFile(join(value.extensionPath,'connection-hint.json'),'utf8'));if(typeof hint.descriptor==='string'){await descriptor(hint.descriptor);descriptorPath=hint.descriptor;await value.globalState.update('descriptor',descriptorPath);}}catch{}
  output.appendLine('OpenCraft IDE bridge activated.');
  const choose=async path=>{
    if(!path)path=await vscode.window.showInputBox({prompt:vscode.l10n.t('OpenCraft connection file path'),ignoreFocusOut:true});
    if(!path)return;await descriptor(path);descriptorPath=path;await context.globalState.update('descriptor',path);
    socket?.close();socket=undefined;await connect();
  };
  value.subscriptions.push(vscode.commands.registerCommand('opencraft.codebuddyIde.connect',()=>choose().catch(()=>vscode.window.showErrorMessage(vscode.l10n.t('Could not connect to OpenCraft. Check the connection file and try again.')))));
  value.subscriptions.push(vscode.window.registerUriHandler({handleUri:uri=>{
    if(uri.path!=='/connect')return;
    void choose(new URLSearchParams(uri.query).get('descriptor')).catch(()=>vscode.window.showErrorMessage(vscode.l10n.t('Could not connect to OpenCraft. Check the connection file and try again.')));
  }}));
  if(descriptorPath)void connect();
}
export function deactivate(){closed=true;clearTimeout(timer);socket?.close();socket=undefined;}
