import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import lockfile from 'proper-lockfile';

export async function readJson(path:string):Promise<unknown|null>{
  let text:string;try{text=await readFile(path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
  try{const value=JSON.parse(text);if(value===null)throw new Error();return value}catch{throw new Error('配置 JSON 损坏，未覆盖原文件')}
}
export async function writeJson(path:string,value:unknown){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path)}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
}
export async function locked<T>(path:string,fn:()=>Promise<T>):Promise<T>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const release=await lockfile.lock(path,{realpath:false,retries:{retries:20,minTimeout:20,maxTimeout:200}});
  try{return await fn()}finally{await release()}
}
