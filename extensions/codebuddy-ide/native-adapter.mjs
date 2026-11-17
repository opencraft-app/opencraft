import {randomUUID} from 'node:crypto';
const PREFIX='tencentcloud.codingcopilot.';
const REQUIRED=['getContext','chat.sendMessage','isAgentBusy','ide.getRuntimeProductConfig'].map(name=>PREFIX+name);
export class NativeCodeBuddyAdapter {
  constructor(commands,workspace,trusted=()=>true){this.commands=commands;this.workspace=workspace;this.trusted=trusted;this.accepted=new Map();this.pending=new Set();}
  async describe(){
    const commands=new Set(await this.commands.getCommands(true));
    if(REQUIRED.some(command=>!commands.has(command)))throw new Error('CodeBuddy IDE command interface is unavailable');
    const context=await this.commands.executeCommand(PREFIX+'getContext',{ensureConversation:false});
    if(!context||typeof context.authenticated!=='boolean')throw new Error('Unsupported CodeBuddy IDE account response');
    return {workspaceTrusted:this.trusted(),authenticated:context.authenticated,account:typeof context.userName==='string'?context.userName:null,
      userId:typeof context.userId==='string'?context.userId:null,cwd:this.workspace(),currentSessionId:typeof context.conversationId==='string'?context.conversationId:null};
  }
  async call(method,params={}){
    if(method==='describe')return this.describe();
    if(method==='trust'){await this.commands.executeCommand('workbench.trust.manage');return {started:true};}
    if(method==='sign-in'){await this.commands.executeCommand(PREFIX+'login');return {started:true};}
    const state=await this.describe();if(!state.workspaceTrusted)throw new Error('Trust the project in CodeBuddy IDE before sending');if(!state.authenticated)throw new Error('Sign in to CodeBuddy IDE first');
    if(method==='new'){
      if(params.cwd!==state.cwd)throw new Error('Open this project in CodeBuddy IDE before starting a conversation');
      const sessionId=randomUUID();this.accepted.set(sessionId,{cwd:state.cwd,userId:state.userId});return {sessionId};
    }
    if(method==='resume'){
      if(params.cwd!==state.cwd)throw new Error('Open the original project in CodeBuddy IDE before resuming');
      const known=this.accepted.get(params.sessionId);
      if(known&&(known.cwd!==state.cwd||known.userId!==state.userId))throw new Error('The IDE account or project changed');
      // A cold import is admitted only after the Host verifies the original
      // transcript in this connected account and project.
      if(!this.accepted.has(params.sessionId)&&state.currentSessionId!==params.sessionId&&params._meta?.['opencraft/nativeHistoryVerified']!==true)throw new Error('Open this conversation in CodeBuddy IDE before resuming');
      this.accepted.set(params.sessionId,{cwd:state.cwd,userId:state.userId});return {sessionId:params.sessionId};
    }
    if(method==='prompt'){
      const id=params.sessionId;
      if(typeof id!=='string'||!this.accepted.has(id)||this.accepted.get(id).cwd!==state.cwd||this.accepted.get(id).userId!==state.userId)throw new Error('Native conversation has not been admitted');
      if(params.cwd!==state.cwd)throw new Error('The IDE project changed; return to the original project');
      if(typeof params.text!=='string'||!params.text.trim()||params.text.length>200000)throw new Error('Invalid message');
      if(this.pending.size)throw new Error('This IDE conversation is already running');
      this.pending.add(id);
      try {
      const busy=await this.commands.executeCommand(PREFIX+'isAgentBusy',id);
      if(!busy||typeof busy.busy!=='boolean'||busy.busy)throw new Error('This conversation is busy in CodeBuddy IDE');

        const result=await this.commands.executeCommand(PREFIX+'chat.sendMessage',{message:params.text,options:{
          conversationId:id,headless:true,waitForCompletion:true,withSummary:false,timeout:300000}});
        const completion=result?.completion;
        if(result?.id!==id||completion?.conversationId!==id||completion?.success!==true)throw new Error('CodeBuddy IDE did not confirm completion; check the original conversation before retrying');
        if(!Array.isArray(completion.messages))throw new Error('CodeBuddy IDE returned no conversation result');
        return {sessionId:id,messages:completion.messages.filter(message=>message?.role==='assistant'&&typeof message.content==='string').map(message=>({text:message.content}))};
      }finally{this.pending.delete(id);}
    }
    throw new Error('Unsupported IDE operation');
  }
}
