import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, readFileSync, closeSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { CapabilitySession } from "./index.js";

/** A stable signing key, never a model-visible global credential. Tokens bind a
 * single server/thread/execution. Domain providers reauthorize independently on each call.
 */
export function capabilitySigningKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, randomBytes(32)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
  const key = readFileSync(path), info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) || key.length !== 32) throw new Error("Invalid capability signing key");
  return key;
}
export function sessionCapabilityToken(key: Buffer, session: CapabilitySession): string {
  const payload = Buffer.from(JSON.stringify(session.execution ? ["execution", session.serverId, session.threadId, session.execution] : ["session", session.serverId, session.threadId])).toString("base64url");
  return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}

/** Verify the existing execution capability without trusting transport metadata. */
export function executionCapabilitySession(key:Buffer,token:string):CapabilitySession {
  const [payload,signature,...extra]=token.split('.');
  if(!payload||!signature||extra.length||token.length>4096)throw Error('cliUnavailable');
  const expected=createHmac('sha256',key).update(payload).digest();
  const actual=Buffer.from(signature,'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('cliUnavailable');
  const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
  if(!Array.isArray(claims)||claims.length!==4||claims[0]!=='execution'
    || ![claims[1],claims[2]].every(v=>typeof v==='string'&&v.length>0&&v.length<=512)
    || !claims[3]||typeof claims[3]!=='object'||Array.isArray(claims[3])
    || Object.keys(claims[3]).some(k=>!['executionId','inputId','turnId','incarnation','callId'].includes(k))
    || Object.values(claims[3]).some(v=>typeof v!=='string'||!v||v.length>512)
    || !claims[3].inputId||!claims[3].executionId)throw Error('cliUnavailable');
  return {serverId:claims[1],threadId:claims[2],execution:claims[3]};
}
