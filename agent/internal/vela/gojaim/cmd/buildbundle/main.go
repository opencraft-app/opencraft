// Command buildbundle creates the single JavaScript asset embedded by
// package gojaim. It accepts LiteChat's self-contained professional browser
// bundle and adds only the Vela host/facade boundary.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const liteChatProfessionalSHA256 = "cb69bbb49421c79d4b9dc5a2871595c76800c38b9cb516662b4f194cdd173fff"
const timUploadPluginSHA256 = "fcbb109a91240c2f3a0b078ddf8bcee6b0a1c67e70b7bd32e9e1868cbc5c89a1"

const hostPrelude = `(function(g){
"use strict";
if(!g.__velaHost){throw new Error("missing __velaHost");}
if(!g.console){g.console={log:function(){},info:function(){},warn:function(){},error:function(){},debug:function(){},trace:function(){}};}
g.window=g;
g.self=g;
g.navigator={cookieEnabled:false,onLine:true,userAgent:"VelaGoja/1"};
g.location={href:"vela://agent"};
g.addEventListener=function(){};
g.removeEventListener=function(){};
g.document={charset:"utf-8",visibilityState:"visible",addEventListener:function(){},removeEventListener:function(){}};
g.localStorage={getItem:function(){return null;},setItem:function(){},clear:function(){}};
function bytesOf(part){
  if(part===null||part===undefined)return new Uint8Array(0);
  if(part instanceof ArrayBuffer)return new Uint8Array(part);
  if(ArrayBuffer.isView&&ArrayBuffer.isView(part))return new Uint8Array(part.buffer,part.byteOffset,part.byteLength);
  if(Array.isArray(part))return new Uint8Array(part);
  if(typeof part==="string"){
    var values=[];
    for(var index=0;index<part.length;index++)values.push(part.charCodeAt(index)&255);
    return new Uint8Array(values);
  }
  if(part&&part._velaBytes)return bytesOf(part._velaBytes);
  throw new TypeError("unsupported File part");
}
g.File=function(parts,name,options){
  var chunks=(parts||[]).map(bytesOf),size=chunks.reduce(function(total,chunk){return total+chunk.byteLength;},0);
  var merged=new Uint8Array(size),offset=0;
  chunks.forEach(function(chunk){merged.set(chunk,offset);offset+=chunk.byteLength;});
  this.name=String(name||"");this.type=String(options&&options.type||"");this.size=size;
  this.lastModified=Number(options&&options.lastModified||Date.now());this._velaBytes=merged.buffer;
};
Object.defineProperty(g.File.prototype,Symbol.toStringTag,{value:"File"});
g.WebSocket=function(url){
  var socket=this;
  socket.binaryType="arraybuffer";
  socket.readyState=0;
  socket._id=g.__velaHost.websocket.open(String(url),function(event){
    if(event.type==="open"){socket.readyState=1;if(socket.onopen)socket.onopen({});return;}
    if(event.type==="message"){if(socket.onmessage)socket.onmessage({data:event.data});return;}
    if(event.type==="close"){socket.readyState=3;if(socket.onclose)socket.onclose({code:event.code||1000,reason:event.reason||""});return;}
    if(event.type==="error"&&socket.onerror)socket.onerror({code:event.code||"websocket_error"});
  });
};
g.WebSocket.prototype.send=function(data){g.__velaHost.websocket.send(this._id,data);};
g.WebSocket.prototype.close=function(){g.__velaHost.websocket.close(this._id);};
g.XMLHttpRequest=function(){this.readyState=0;this.status=0;this.statusText="";this.responseText="";this._headers={};this._responseHeaders={};this.upload={};};
g.XMLHttpRequest.prototype.open=function(method,url){this._method=String(method);this._url=String(url);this.readyState=1;};
g.XMLHttpRequest.prototype.setRequestHeader=function(k,v){this._headers[String(k)]=String(v);};
g.XMLHttpRequest.prototype.getAllResponseHeaders=function(){
  return Object.keys(this._responseHeaders).map(function(key){return key+": "+this._responseHeaders[key];},this).join("\r\n");
};
g.XMLHttpRequest.prototype.abort=function(){if(this._requestId)g.__velaHost.fetch.abort(this._requestId);};
g.XMLHttpRequest.prototype.send=function(body){
  var xhr=this;
  xhr._requestId=g.__velaHost.fetch.start({
    method:xhr._method,url:xhr._url,headers:xhr._headers,
    body:body&&body._velaBytes?body._velaBytes:(body===undefined?null:body)
  },function(result){
    xhr.readyState=4;xhr.status=result.status||0;xhr.statusText=result.status_text||"";
    xhr.responseText=result.body||"";xhr._responseHeaders=result.headers||{};
    if(xhr.upload&&xhr.upload.onprogress&&body&&body.size!==undefined)xhr.upload.onprogress({loaded:body.size,total:body.size});
    if(xhr.onreadystatechange)xhr.onreadystatechange();
    if(result.error){if(xhr.onerror)xhr.onerror({message:result.error});}
    else if(xhr.onload)xhr.onload();
  });
};
})(globalThis);
`

const facade = `
(function(g){
"use strict";
var clients=new Map(),nextID=1;
function eventsFor(client){return client.events.splice(0,client.events.length);}
function attach(client,sdk){
  var E=g.TencentCloudChat.EVENT||{};
  [
    ["SDK_READY","ready"],["SDK_NOT_READY","not_ready"],
    ["MESSAGE_RECEIVED","message"],["NET_STATE_CHANGE","network_changed"],
    ["USER_SIG_EXPIRED","usersig_expiring"],["KICKED_OUT","kicked_out"],
    ["ERROR","sdk_error"],["CONVERSATION_LIST_UPDATED","conversation_updated"]
  ].forEach(function(pair){
    var eventName=E[pair[0]];
    if(eventName&&sdk.on)sdk.on(eventName,function(event){
      client.events.push({type:pair[1],data:event&&event.data!==undefined?event.data:event});
    });
  });
}
function create(config){
  if(!g.TencentCloudChat||typeof g.TencentCloudChat.create!=="function")throw new Error("LiteChat create unavailable");
  var sdk=g.TencentCloudChat.create({SDKAppID:Number(config.SDKAppID)});
  if(!sdk)throw new Error("LiteChat create failed");
  if(!g.TIMUploadPlugin)throw new Error("TIM upload plugin unavailable");
  sdk.registerPlugin({"tim-upload-plugin":g.TIMUploadPlugin});
  var id=String(nextID++),client={sdk:sdk,events:[]};
  clients.set(id,client);attach(client,sdk);return id;
}
function conversationTarget(sdk,conversation){
  if(!conversation||typeof conversation!=="object")throw new Error("invalid conversation");
  if(conversation.type==="c2c"&&conversation.peer_user_id)return {to:conversation.peer_user_id,conversationType:g.TencentCloudChat.TYPES.CONV_C2C};
  if(conversation.type==="group"&&conversation.group_id)return {to:conversation.group_id,conversationType:g.TencentCloudChat.TYPES.CONV_GROUP};
  if(conversation.type==="topic"&&conversation.group_id&&conversation.topic_id)return {to:conversation.topic_id,conversationType:g.TencentCloudChat.TYPES.CONV_GROUP};
  throw new Error("invalid conversation");
}
function conversationID(conversation){
  if(conversation&&conversation.type==="c2c"&&conversation.peer_user_id)return "C2C"+conversation.peer_user_id;
  if(conversation&&conversation.type==="group"&&conversation.group_id)return "GROUP"+conversation.group_id;
  if(conversation&&conversation.type==="topic"&&conversation.group_id&&conversation.topic_id)return "GROUP"+conversation.topic_id;
  throw new Error("invalid conversation");
}
function receipt(response){
  var message=response&&response.data&&response.data.message;
  if(!message||!message.ID||!message.time)throw new Error("invalid receipt");
  return {message_id:message.ID,timestamp_ms:Math.trunc(message.time*1000),sequence:Number(message.sequence||0)};
}
function attachmentReceipt(response,request){
  var result=receipt(response),message=response&&response.data&&response.data.message,payload=message&&message.payload||{};
  result.attachment={
    id:String(payload.uuid||payload.UUID||message.ID||""),
    filename:String(payload.fileName||request.filename||""),
    mime_type:String(request.mime_type||"application/octet-stream"),
    size_bytes:Number(payload.fileSize||request.data&&request.data.length||0),
    url:String(payload.fileUrl||payload.url||"")
  };
  return result;
}
var hoppingTimePrefix="vela-hopping-v1:";
var hoppingSequencePrefix="vela-group-hopping-v1:";
function hoppingPage(sdk,options,kind){
  return sdk.getMessageListHopping(options).then(function(response){
    var data=response&&response.data;
    if(!data||!Array.isArray(data.messageList)||typeof data.isCompleted!=="boolean")throw new Error("invalid history");
    var cursor="";
    if(!data.isCompleted){
      var next=kind==="sequence"?Number(data.nextMessageSeq):Number(data.nextMessageTime);
      if(!Number.isSafeInteger(next)||next<=0)throw new Error("invalid history cursor");
      cursor=(kind==="sequence"?hoppingSequencePrefix:hoppingTimePrefix)+String(next);
    }
    return {data:{messageList:data.messageList,isCompleted:data.isCompleted,nextReqMessageID:cursor}};
  });
}
function history(sdk,request){
  var target=conversationID(request.conversation),cursor=String(request.cursor||"");
  if(cursor.indexOf(hoppingSequencePrefix)===0){
    return hoppingPage(sdk,{conversationID:target,sequence:Number(cursor.slice(hoppingSequencePrefix.length)),direction:1},"sequence");
  }
  if(cursor.indexOf(hoppingTimePrefix)===0){
    return hoppingPage(sdk,{conversationID:target,time:Number(cursor.slice(hoppingTimePrefix.length)),direction:0},"time");
  }
  if(request.after_sequence){
    return hoppingPage(sdk,{conversationID:target,sequence:Number(request.after_sequence),direction:1},"sequence");
  }
  if(request.around_sequence){
    return hoppingPage(sdk,{conversationID:target,sequence:Number(request.around_sequence),direction:0},"sequence");
  }
  if(request.around_time_ms){
    return hoppingPage(sdk,{conversationID:target,time:Math.trunc(Number(request.around_time_ms)/1000),direction:0},"time");
  }
  var options={conversationID:target};
  if(cursor)options.nextReqMessageID=cursor;
  return sdk.getMessageList(options).then(function(response){
    var data=response&&response.data;
    if(!data||!Array.isArray(data.messageList)||typeof data.isCompleted!=="boolean")throw new Error("invalid history");
    if(!cursor&&target.indexOf("C2C")===0&&data.messageList.length===0&&data.isCompleted&&typeof sdk.getMessageListHopping==="function"){
      return hoppingPage(sdk,{conversationID:target,time:Math.trunc(Date.now()/1000),direction:0},"time");
    }
    return response;
  });
}
function textOf(message){
  var payload=message&&message.payload;
  return payload&&typeof payload.text==="string"?payload.text:"";
}
function searchHistoryPage(sdk,request){
  return history(sdk,{conversation:request.conversation,cursor:request.cursor||""}).then(function(response){
    var data=response&&response.data;
    if(!data||!Array.isArray(data.messageList))throw new Error("invalid history search");
    var query=String(request.query||"").toLocaleLowerCase("zh-CN");
    var messages=data.messageList.filter(function(message){
      return textOf(message).toLocaleLowerCase("zh-CN").indexOf(query)>=0;
    });
    return {data:{
      isCompleted:data.isCompleted===true,
      messageList:messages,
      nextCursor:String(data.nextReqMessageID||""),
      totalCount:messages.length
    }};
  });
}
function search(sdk,request){
  var conversation=request.conversation;
  if(conversation&&conversation.type==="topic")return searchHistoryPage(sdk,request);
  if(typeof sdk.searchCloudMessages!=="function"||sdk.__velaCloudSearchUnavailable)return searchHistoryPage(sdk,request);
  var options={
    count:Number(request.limit||20),
    keywordList:[String(request.query||"")],
    keywordListMatchType:"and"
  };
  if(conversation)options.conversationID=conversationID(conversation);
  if(request.cursor)options.cursor=String(request.cursor);
  return sdk.searchCloudMessages(options).catch(function(){
    sdk.__velaCloudSearchUnavailable=true;
    return searchHistoryPage(sdk,request);
  });
}
function findMessageByRef(sdk,request){
  var found=typeof sdk.findMessage==="function"?sdk.findMessage(String(request.message_id||"")):null;
  if(found)return Promise.resolve(found);
  if(typeof sdk.getMessageListHopping!=="function"||!Number(request.sequence))return Promise.reject(new Error("message unavailable"));
  return sdk.getMessageListHopping({
    conversationID:conversationID(request.conversation),count:1,direction:0,sequence:Number(request.sequence)
  }).then(function(response){
    var data=response&&response.data,list=data&&data.messageList;
    if(!Array.isArray(list))throw new Error("invalid hopping result");
    for(var index=0;index<list.length;index++)if(list[index]&&list[index].ID===request.message_id)return list[index];
    throw new Error("message unavailable");
  });
}
function setReaction(sdk,request){
  return findMessageByRef(sdk,request).then(function(message){
    var method=request.active?sdk.addMessageReaction:sdk.removeMessageReaction;
    if(typeof method!=="function")throw new Error("reaction unavailable");
    return method.call(sdk,message,String(request.reaction_id||""));
  });
}
function revoke(sdk,request){
  return findMessageByRef(sdk,request).then(function(message){
    if(typeof sdk.revokeMessage!=="function")throw new Error("revoke unavailable");
    return sdk.revokeMessage(message).then(function(){return {ok:true};});
  });
}
function command(id,request){
  var client=clients.get(String(id));
  if(!client)throw new Error("unknown client");
  var sdk=client.sdk,op=String(request.op||"");
  if(op==="login")return sdk.login({userID:request.userID,userSig:request.userSig});
	if(op==="loginState")return {
		userID:typeof sdk.getLoginUser==="function"?String(sdk.getLoginUser()||""):"",
		ready:typeof sdk.isReady==="function"&&sdk.isReady()===true
	};
  if(op==="logout")return sdk.logout();
  if(op==="sendText"){
    var target=conversationTarget(sdk,request.conversation);
    var mentions=Array.isArray(request.mention_user_ids)?request.mention_user_ids:[];
    if(mentions.length&&request.conversation.type==="c2c")throw new Error("invalid mention");
    var options=Object.assign({},target,{payload:{text:String(request.text||"")},cloudCustomData:String(request.cloud_custom_data||"")});
    var message=mentions.length?sdk.createTextAtMessage(Object.assign({},target,{payload:{text:String(request.text||""),atUserList:mentions},cloudCustomData:String(request.cloud_custom_data||"")})):sdk.createTextMessage(options);
    return sdk.sendMessage(message,{onlineUserOnly:false}).then(receipt);
  }
  if(op==="sendCustom"){
    var customTarget=conversationTarget(sdk,request.conversation);
    var custom=sdk.createCustomMessage(Object.assign({},customTarget,{payload:{
      data:JSON.stringify(request.data),description:String(request.custom_type||""),extension:"vela/v1"
    }}));
    return sdk.sendMessage(custom,{onlineUserOnly:false}).then(receipt);
  }
  if(op==="sendAttachment"){
    var attachmentTarget=conversationTarget(sdk,request.conversation);
    var file=new g.File([request.data],String(request.filename||""),{type:String(request.mime_type||"application/octet-stream")});
    var attachmentOptions=Object.assign({},attachmentTarget,{payload:{file:file}});
    var attachmentCloudCustomData=String(request.cloud_custom_data||"");
    if(attachmentCloudCustomData)attachmentOptions.cloudCustomData=attachmentCloudCustomData;
    var fileMessage=sdk.createFileMessage(attachmentOptions);
    return sdk.sendMessage(fileMessage,{onlineUserOnly:false}).then(function(response){return attachmentReceipt(response,request);});
  }
  if(op==="listUnread")return sdk.getConversationList({hasUnreadCount:true}).then(function(response){
    return response&&response.data?response.data:{conversationList:[],isSyncCompleted:false};
  });
  if(op==="listConversations")return sdk.getConversationList({}).then(function(response){
    return response&&response.data?response.data:{conversationList:[],isSyncCompleted:false};
  });
  if(op==="history")return history(sdk,request);
  if(op==="markRead")return sdk.setMessageRead({conversationID:conversationID(request.conversation)});
  if(op==="search")return search(sdk,request);
  if(op==="setReaction")return setReaction(sdk,request);
  if(op==="revoke")return revoke(sdk,request);
  if(op==="sendMessage")return sdk.sendMessage(request.message);
  if(op==="getConversationList")return sdk.getConversationList(request.options||{});
  if(op==="getMessageList")return sdk.getMessageList(request.options||{});
  if(op==="getMessageListHopping")return sdk.getMessageListHopping(request.options||{});
  if(op==="setMessageRead")return sdk.setMessageRead(request.options||{});
  throw new Error("unsupported command: "+op);
}
function close(id){
  var client=clients.get(String(id));
  if(!client)return Promise.resolve();
  clients.delete(String(id));
  if(client.sdk.destroy)return client.sdk.destroy();
  return client.sdk.logout?client.sdk.logout():Promise.resolve();
}
g.__velaLiteChat={create:create,command:command,close:close,drainEvents:function(id){
  var client=clients.get(String(id));return client?eventsFor(client):[];
}};
})(globalThis);
`

func main() {
	var input string
	var upload string
	var output string
	flag.StringVar(&input, "input", "", "LiteChat professional.js path")
	flag.StringVar(&upload, "upload", "", "TIM upload plugin browser bundle path")
	flag.StringVar(&output, "output", "", "generated lite-chat-goja.js path")
	flag.Parse()
	if err := run(input, upload, output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(input, upload, output string) error {
	if input == "" || upload == "" || output == "" {
		return errors.New("input, upload and output are required")
	}
	source, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(source)
	if hex.EncodeToString(sum[:]) != liteChatProfessionalSHA256 {
		return errors.New("LiteChat professional.js SHA-256 mismatch")
	}
	text := string(source)
	if len(text) < 100_000 || strings.Contains(text, "require(") {
		return errors.New("input is not a self-contained LiteChat browser bundle")
	}
	uploadSource, err := os.ReadFile(upload)
	if err != nil {
		return err
	}
	if err := validateUploadPlugin(uploadSource); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	return os.WriteFile(
		output,
		[]byte(hostPrelude+text+string(uploadSource)+facade),
		0o644,
	)
}

func validateUploadPlugin(source []byte) error {
	sum := sha256.Sum256(source)
	if hex.EncodeToString(sum[:]) != timUploadPluginSHA256 {
		return errors.New("TIM upload plugin SHA-256 mismatch")
	}
	if len(source) < 5_000 || !strings.Contains(string(source), "TIMUploadPlugin") {
		return errors.New("input is not the TIM browser upload plugin")
	}
	return nil
}
