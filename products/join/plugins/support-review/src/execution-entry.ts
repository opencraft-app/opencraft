import {isAbsolute} from 'node:path';
import {reviewConfiguration} from './config';
import {startReviewHandsOwner} from './hands-owner';
import type {RuntimePluginContext,RuntimePluginService} from '../../../runtime-plugins/contract';
export async function activate(context: RuntimePluginContext): Promise<RuntimePluginService> {
  if(context.hostApi!==1||context.role!=='execution'||Object.keys(context.configuration).some(key=>key!=='configFile')
    || typeof context.configuration.configFile!=='string'||!isAbsolute(context.configuration.configFile))throw Error('Invalid review execution plugin configuration');
  const configuration=await reviewConfiguration('hands',{OPENCRAFT_SUPPORT_REVIEW_CONFIG:context.configuration.configFile});
  if(!configuration)throw Error('Review execution configuration missing');
  return startReviewHandsOwner(configuration,{onFailure:context.onFailure,revision:context.revision,drainOnClose:true});
}
