import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { CapabilitySession } from "./index.js";

/** A stable signing key, never a model-visible global credential. Tokens bind a
 * single server/thread/execution. Domain providers reauthorize independently on each call.
 */
export async function capabilitySigningKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const created = await open(path, "wx", 0o600);
    try { await created.writeFile(randomBytes(32)); } finally { await created.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const handle = await open(path, "r");
  try {
    const [key, info] = [await handle.readFile(), await handle.stat()];
    if (!info.isFile() || (info.mode & 0o077) || key.length !== 32) throw new Error("Invalid capability signing key");
    return key;
  } finally { await handle.close(); }
}
export function sessionCapabilityToken(key: Buffer, session: CapabilitySession): string {
  const payload = Buffer.from(JSON.stringify(session.execution ? ["execution", session.serverId, session.threadId, session.execution] : ["session", session.serverId, session.threadId])).toString("base64url");
  return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}

/** Host-only, single native tool invocation audience. A CLI session token must
 * never gain retry identity merely by choosing a JSON-RPC request id. */
export function nativeToolCapabilityToken(key: Buffer, session: CapabilitySession): string {
  if (!session.execution?.callId) throw new Error('Native capability requires a tool call identity');
  const payload = Buffer.from(JSON.stringify(['native-tool', session.serverId, session.threadId, session.execution])).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}

/** Dedicated execution admission audience; MCP credentials retain their existing audience. */
export function executionCliSourceToken(key:Buffer,session:CapabilitySession):string {
  if(!session.execution?.inputId||!session.execution.executionId)throw Error('cliUnavailable');
  const payload=Buffer.from(JSON.stringify(['execution-cli',session.serverId,session.threadId,session.execution])).toString('base64url');
  return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
}

/** Verify the existing execution capability without trusting transport metadata. */
export function executionCliSourceSession(key:Buffer,token:string):CapabilitySession {
  const [payload,signature,...extra]=token.split('.');
  if(!payload||!signature||extra.length||token.length>4096)throw Error('cliUnavailable');
  const expected=createHmac('sha256',key).update(payload).digest();
  const actual=Buffer.from(signature,'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('cliUnavailable');
  const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
  if(!Array.isArray(claims)||claims.length!==4||claims[0]!=='execution-cli'
    || ![claims[1],claims[2]].every(v=>typeof v==='string'&&v.length>0&&v.length<=512)
    || !claims[3]||typeof claims[3]!=='object'||Array.isArray(claims[3])
    || Object.keys(claims[3]).some(k=>!['executionId','inputId','turnId','incarnation','callId'].includes(k))
    || Object.values(claims[3]).some(v=>typeof v!=='string'||!v||v.length>512)
    || !claims[3].inputId||!claims[3].executionId)throw Error('cliUnavailable');
  return {serverId:claims[1],threadId:claims[2],execution:claims[3]};
}


export type HostGitSource = {readonly inputId:string;readonly turnId?:never}|{readonly turnId:string;readonly inputId?:never};
export function parseHostGitSource(value:unknown):HostGitSource {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('git_execution_unavailable');
 const keys=Object.keys(value),source=value as Record<string,unknown>;
 if(keys.length!==1||!['inputId','turnId'].includes(keys[0]!))throw Error('git_execution_unavailable');
 const id=source[keys[0]!];if(typeof id!=='string'||!id||id.length>512||/[\x00-\x1f\x7f]/u.test(id))throw Error('git_execution_unavailable');
 return Object.freeze(keys[0]==='inputId'?{inputId:id}:{turnId:id});
}
/** Same-UID compiled Host handoff, not an MCP or model CLI audience. The Server
 * still derives identity and verifies the exact live native execution. */
export function hostGitToken(key: Buffer, source: {serverId:string;threadId:string;source:HostGitSource}):string {
 if(key.length!==32||[source.serverId,source.threadId].some(v=>typeof v!=='string'||!v||v.length>512||/[\x00-\x1f\x7f]/u.test(v)))throw Error('git_execution_unavailable');
 const payload=Buffer.from(JSON.stringify(['host-git',source.serverId,source.threadId,parseHostGitSource(source.source)])).toString('base64url');
 return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
}
