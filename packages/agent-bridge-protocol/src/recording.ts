/**
 * Desensitized recording contract. Recordings have two layers: the provider
 * wire -> semantic delta boundary (`nativeToDelta`) and the semantic delta ->
 * canonical event boundary (`deltaToEvent`). A replay drives only the pure
 * translator/assembler against a fake native port; it never opens a network
 * connection, runs a real tool, or executes a recorded shell command.
 *
 * Every cell pins its versions, artifact digest, permission mode, mapper,
 * order and clock/sequence seeds. Account tokens and keys are not recorded;
 * content and paths are replaced by stable correlation tokens so that a delta
 * can still be linked back to its source line without exposing the content.
 */

import { BRIDGE_SCHEMA_ID, BRIDGE_SCHEMA_VERSION } from "./version";

export type RecordingLane = "nativeToDelta" | "deltaToEvent";

export interface RedactionPolicy {
  readonly secretsRemoved: true;
  readonly contentRedacted: true;
  readonly pathsRedacted: true;
  readonly correlationIdsKept: true;
}

export interface BridgeRecordingManifest {
  readonly schemaVersion: number;
  readonly schemaId: string;
  readonly protocolVersion: number;
  readonly grammarVersion: number;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly pluginDigest: string;
  readonly permissionMode: string;
  readonly mapperVersion: number;
  readonly clockSeed: number;
  readonly sequenceSeed: number;
  readonly cell: string;
  readonly redaction: RedactionPolicy;
}

export const BRIDGE_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  secretsRemoved: true,
  contentRedacted: true,
  pathsRedacted: true,
  correlationIdsKept: true,
});

/** One NDJSON entry on a recording lane. */
export interface RecordingLine {
  readonly seq: number;
  readonly run: string;
  readonly lane: RecordingLane;
  /** Already-desensitized JSON payload for this boundary crossing. */
  readonly line: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: BridgeRecordingManifest }
  | { readonly ok: false; readonly reason: string };

/** Refuse a recording whose schema version this assembler cannot reproduce. */
export function parseRecordingManifest(value: unknown): ManifestParseResult {
  if (!isRecord(value)) return { ok: false, reason: "manifest is not an object" };
  if (value.schemaVersion !== BRIDGE_SCHEMA_VERSION || value.schemaId !== BRIDGE_SCHEMA_ID) {
    return { ok: false, reason: "recording schema version mismatch; replay refused" };
  }
  const numeric = ["protocolVersion", "grammarVersion", "mapperVersion", "clockSeed", "sequenceSeed"] as const;
  for (const key of numeric) {
    if (typeof value[key] !== "number") return { ok: false, reason: `manifest.${key} must be a number` };
  }
  const text = ["providerId", "providerVersion", "pluginDigest", "permissionMode", "cell"] as const;
  for (const key of text) {
    if (typeof value[key] !== "string") return { ok: false, reason: `manifest.${key} must be a string` };
  }
  if (!isRecord(value.redaction)) return { ok: false, reason: "manifest.redaction is required" };
  return { ok: true, manifest: value as unknown as BridgeRecordingManifest };
}

/** Deterministic, non-cryptographic correlation token (FNV-1a over UTF-16 units). */
export function stableToken(value: string, seed = BRIDGE_SCHEMA_VERSION): string {
  let hash = 0x811c9dc5 ^ seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function redactContent(text: string): string {
  return `[content:${stableToken(text)}]`;
}

export function redactPath(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const leaf = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = leaf.lastIndexOf(".");
  const extension = dot > 0 ? leaf.slice(dot) : "";
  return `[path:${stableToken(path)}${extension}]`;
}

const SECRET_KEY = /(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key|cookie)/i;

/**
 * Drop secret-bearing fields from a recorded structure. Correlation ids are
 * ordinary keys and survive; only credential-like keys are removed. Pure: it
 * returns a new value and never mutates the input.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = redactSecrets(entry);
  }
  return out;
}

/** Parse one NDJSON recording line, checking its versioned shape. */
export function parseRecordingLine(raw: string): RecordingLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.seq !== "number" || typeof parsed.run !== "string"
    || (parsed.lane !== "nativeToDelta" && parsed.lane !== "deltaToEvent")
    || typeof parsed.line !== "string") {
    return null;
  }
  return parsed as unknown as RecordingLine;
}
