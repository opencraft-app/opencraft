import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CodexAppServerHealth } from "@opencraft/account-pool-host";
import type { GenerationRecord } from "./generation-registry.js";
import type { GenerationProcessIdentity } from "./generation-supervisor.js";

/** A durable APP-only choice. All other launch inputs and file bytes stay fixed. */
export interface AppPayloadChoice {
  readonly version: 1;
  readonly bundle: string;
  readonly bundleSha256: string;
  readonly fixedDefinition: string;
  readonly files: Readonly<Record<string, string>>;
  readonly cliSha256: string;
  readonly cliVersion: string;
  readonly incarnation: number;
  readonly applied: boolean;
  readonly sourceBundle: { readonly path: string; readonly sha256: string };
  readonly restoringSourceApp: boolean;
}
export interface AppPayloadRequest {
  id: string; bundle: string; bundleSha256: string;
  expectedIncarnation: number; expectedEpoch: number; expectedOwner: string; expectedHost: string;
}
export function appPayloadRequest(value: Record<string, unknown>): AppPayloadRequest {
  const keys = ["id", "bundle", "bundleSha256", "expectedIncarnation", "expectedEpoch", "expectedOwner", "expectedHost"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))
    || ["id", "bundle", "expectedOwner", "expectedHost"].some(key => typeof value[key] !== "string" || !value[key])
    || typeof value.bundleSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.bundleSha256)
    || !isAbsolute(value.bundle as string) || ![value.expectedIncarnation, value.expectedEpoch].every(v => Number.isSafeInteger(v) && Number(v) >= 0)) throw new Error("Invalid APP-only payload selection");
  return value as unknown as AppPayloadRequest;
}
export function fixedAppDefinition(g: GenerationRecord): string {
  const { bundle: _bundle, externalUnit: _unit, state: _state, incarnation: _incarnation, ...fixed } = g;
  return JSON.stringify(fixed);
}
export async function payloadFileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
export async function newAppChoice(g: GenerationRecord, identity: GenerationProcessIdentity, request: AppPayloadRequest, previous?: AppPayloadChoice | null): Promise<AppPayloadChoice> {
  if (!identity?.cliSha256 || !identity.cliVersion) throw new Error("APP selection needs an observed CLI identity");
  // Store real paths for the new artifact; the existing launch definition stays byte-for-byte fixed.
  const bundle = await realpath(request.bundle);
  if (await payloadFileHash(bundle) !== request.bundleSha256) throw new Error("APP target bundle digest changed");
  const paths = [...new Set([g.executable, g.node, ...(g.nativeLauncher ? [g.nativeLauncher.entrypoint, g.nativeLauncher.executable] : [])])];
  if (previous) await verifyFixedAppChoice(g, previous);
  const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, await payloadFileHash(path)])));
  if (files[g.nativeLauncher?.executable ?? g.executable] !== identity.cliSha256) throw new Error("APP source CLI bytes differ from observed identity");
  const sourceBundle = previous?.sourceBundle ?? { path: await realpath(g.bundle), sha256: await payloadFileHash(g.bundle) };
  return { version: 1, sourceBundle, restoringSourceApp: bundle === sourceBundle.path && request.bundleSha256 === sourceBundle.sha256, bundle, bundleSha256: request.bundleSha256, fixedDefinition: fixedAppDefinition(g), files,
    cliSha256: identity.cliSha256, cliVersion: identity.cliVersion, incarnation: g.incarnation, applied: false };
}
export async function verifyFixedAppChoice(g: GenerationRecord, choice: AppPayloadChoice): Promise<void> {
  if (choice.fixedDefinition !== fixedAppDefinition(g)) throw new Error("APP-only fixed launch definition changed");
  for (const [path, digest] of Object.entries(choice.files)) if (await payloadFileHash(path) !== digest) throw new Error("APP-only fixed runtime file changed");
}
export async function verifyAppChoice(g: GenerationRecord, choice: AppPayloadChoice): Promise<void> {
  if (choice.version !== 1 || choice.fixedDefinition !== fixedAppDefinition(g) || choice.applied && g.bundle !== choice.bundle
    || !choice.applied && g.incarnation !== choice.incarnation) throw new Error("APP-only payload identity changed");
  if (await payloadFileHash(choice.bundle) !== choice.bundleSha256) throw new Error("APP target bundle digest changed");
  await verifyFixedAppChoice(g, choice);
}
export function requireCallbackObservation(health: CodexAppServerHealth): void {
  if (health.callbackProtocolVersion !== 1 || ![health.pendingCallbacks, health.pendingOrchestrationMutations].every(v => Number.isSafeInteger(v) && Number(v) === 0)) throw new Error("APP target does not provide an idle callback protocol");
}
