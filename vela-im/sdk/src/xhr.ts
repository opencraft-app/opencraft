/**
 * lite-chat's Node build uploads rich media through XMLHttpRequest, which Node does not provide.
 * This covers exactly the surface its COS uploader uses: open, setRequestHeader, send, onload/onerror,
 * upload.onprogress, status/statusText/responseText and response headers.
 */
class FetchXMLHttpRequest {
 upload:{onprogress:((e:{loaded:number;total:number})=>void)|null}={onprogress:null};
 readyState=0;status=0;statusText='';responseText='';response:unknown=null;responseType='';timeout=0;
 onload:(()=>void)|null=null;onerror:((e?:unknown)=>void)|null=null;onreadystatechange:(()=>void)|null=null;ontimeout:(()=>void)|null=null;
 private method='GET';private url='';private headers:Record<string,string>={};private received=new Headers();private controller:AbortController|undefined;
 open(method:string,url:string) {this.method=method;this.url=url;this.readyState=1}
 setRequestHeader(name:string,value:string) {this.headers[name]=value}
 getResponseHeader(name:string) {return this.received.get(name)}
 getAllResponseHeaders() {let text='';this.received.forEach((v,k)=>{text+=`${k}: ${v}\r\n`});return text}
 abort() {this.controller?.abort()}
 send(body?:BodyInit|null) {
  this.controller=new AbortController();
  const size=(body as Blob|undefined)?.size??(body as ArrayBuffer|undefined)?.byteLength??0;
  const timer=this.timeout?setTimeout(()=>{this.controller?.abort();this.ontimeout?.()},this.timeout):undefined;
  fetch(this.url,{method:this.method,headers:this.headers,body:body??undefined,signal:this.controller.signal}).then(async r=>{
   this.status=r.status;this.statusText=r.statusText;this.received=r.headers;this.responseText=await r.text();this.response=this.responseText;this.readyState=4;
   if(size)this.upload.onprogress?.({loaded:size,total:size});
   this.onreadystatechange?.();this.onload?.();
  },error=>{this.status=0;this.readyState=4;this.onreadystatechange?.();this.onerror?.(error)}).finally(()=>clearTimeout(timer));
 }
}
const g=globalThis as any;
g.XMLHttpRequest??=FetchXMLHttpRequest;
