import {isAbsolute} from 'node:path';
import {HandsReviewExecutor} from './hands-client';
import {reviewConfiguration,readReviewToken} from './config';
import {SupportReviewHttp} from './server';
import type {RuntimePluginContext,RuntimePluginService} from '../../../runtime-plugins/contract';
export async function activate(context: RuntimePluginContext): Promise<RuntimePluginService> {
  if(context.hostApi!==1||context.role!=='gateway'||!context.authority
    || Object.keys(context.configuration).some(key=>key!=='configFile')
    || typeof context.configuration.configFile!=='string'||!isAbsolute(context.configuration.configFile))throw Error('Invalid review Gateway plugin configuration');
  const env={OPENCRAFT_SUPPORT_REVIEW_CONFIG:context.configuration.configFile};
  const configuration=await reviewConfiguration('gateway',env);
  if(!configuration)throw Error('Missing review Gateway configuration');
  await readReviewToken(configuration.tokenFile); // Fail the candidate at startup, not on the first review send.
  const review=new SupportReviewHttp(new HandsReviewExecutor(async()=>configuration,context.revision));
  const authority=context.authority;
  const employee=(request: Parameters<typeof authority.authenticate>[0])=>{
    const principal=authority.authenticate(request);
    if(principal?.provider!=='tencentoa'||principal.expiresAt<=Date.now()||!principal.attributes?.loginName)return null;
    return {subject:principal.subject,loginName:principal.attributes.loginName};
  };
  return {
    async handle(request,response){
      const identity=employee(request);
      if(!identity){response.writeHead(401,{'content-type':'application/json','cache-control':'no-store'});response.end('{"error":"unauthenticated"}');return;}
      await review.handle(request,response,identity,()=>employee(request)?.subject===identity.subject&&authority.admissionStatus(request)===204);
    },
    close(){},
  };
}
