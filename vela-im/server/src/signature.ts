import {createHmac} from 'node:crypto';
import {deflateSync} from 'node:zlib';
export function userSig(appId:number,secret:string,userId:string,expire=3600,time=Math.floor(Date.now()/1000)):string {
 if(!secret)throw new Error('未配置 IM 服务端密钥');
 const content=`TLS.identifier:${userId}\nTLS.sdkappid:${appId}\nTLS.time:${time}\nTLS.expire:${expire}\n`;
 const json={'TLS.ver':'2.0','TLS.identifier':userId,'TLS.sdkappid':appId,'TLS.expire':expire,'TLS.time':time,'TLS.sig':createHmac('sha256',secret).update(content).digest('base64')};
 return deflateSync(Buffer.from(JSON.stringify(json))).toString('base64').replace(/\+/g,'*').replace(/\//g,'-').replace(/=/g,'_');
}
