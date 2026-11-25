import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { KeyMaterial } from "@opencraft/secret-storage";
import type { CapabilitySession } from "./index.js";
import { decodeCapabilityClaims, encodeCapabilityClaims, splitCapabilityToken } from "./credential-wire.js";
import { executionCliClaimsSession, parseHostGitSource, sessionCapabilityClaims, type HostGitSource } from "./session-authority.js";

export { parseHostGitSource, type HostGitSource } from "./session-authority.js";

/** Key name shared by the signing owner and Host attachments in one data directory. */
export const SESSION_CAPABILITY_KEY = "session-capabilities.key";

/** A stable signing key, never a model-visible global credential. Tokens bind a
 * single server/thread/execution. Domain providers reauthorize independently on each call.
 */
export async function capabilitySigningKey(keys: KeyMaterial): Promise<Buffer> {
  const key = Buffer.from(await keys.ensure(SESSION_CAPABILITY_KEY, () => randomBytes(32)));
  if (key.length !== 32) throw new Error("Invalid capability signing key");
  return key;
}
export function signCapabilityClaims(key: Buffer, claims: readonly unknown[]): string {
  const payload = encodeCapabilityClaims(claims);
  return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
}

export function verifyCapabilityToken(key: Buffer, token: string): unknown {
  const parts = splitCapabilityToken(token);
  if (!parts) return null;
  const actual = Buffer.from(parts.signature, "base64url");
  const expected = createHmac("sha256", key).update(parts.payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try { return decodeCapabilityClaims(parts.payload); }
  catch { return null; }
}

export function sessionCapabilityToken(key: Buffer, session: CapabilitySession): string {
  return signCapabilityClaims(key, sessionCapabilityClaims(session));
}

/** Host-only, single native tool invocation audience. A CLI session token must
 * never gain retry identity merely by choosing a JSON-RPC request id. */
export function nativeToolCapabilityToken(key: Buffer, session: CapabilitySession): string {
  if (!session.execution?.callId) throw new Error('Native capability requires a tool call identity');
  return signCapabilityClaims(key, ['native-tool', session.serverId, session.threadId, session.execution]);
}

/** Dedicated execution admission audience; MCP credentials retain their existing audience. */
export function executionCliSourceToken(key:Buffer,session:CapabilitySession):string {
  if(!session.execution?.inputId||!session.execution.executionId)throw Error('cliUnavailable');
  return signCapabilityClaims(key, ['execution-cli', session.serverId, session.threadId, session.execution]);
}

/** Verify the existing execution capability without trusting transport metadata. */
export function executionCliSourceSession(key:Buffer,token:string):CapabilitySession {
  const session = executionCliClaimsSession(verifyCapabilityToken(key, token));
  if (!session) throw Error('cliUnavailable');
  return session;
}

/** Same-UID compiled Host handoff, not an MCP or model CLI audience. The Server
 * still derives identity and verifies the exact live native execution. */
export function hostGitToken(key: Buffer, source: {serverId:string;threadId:string;source:HostGitSource}):string {
 if(key.length!==32||[source.serverId,source.threadId].some(v=>typeof v!=='string'||!v||v.length>512||/[\x00-\x1f\x7f]/u.test(v)))throw Error('git_execution_unavailable');
 return signCapabilityClaims(key, ['host-git', source.serverId, source.threadId, parseHostGitSource(source.source)]);
}
/** Separate same-UID audience for an opaque ENV capsule request. Possessing a
 * Git handoff token never requests ENV, and this token never reads Git. */
export function hostEnvironmentToken(key: Buffer, source: {serverId:string;threadId:string;source:HostGitSource}):string {
 if(key.length!==32||[source.serverId,source.threadId].some(v=>typeof v!=='string'||!v||v.length>512||/[\x00-\x1f\x7f]/u.test(v)))throw Error('environment_launch_unavailable');
 return signCapabilityClaims(key, ['host-environment', source.serverId, source.threadId, parseHostGitSource(source.source)]);
}
