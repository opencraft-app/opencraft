import { parsePersonalPublicKey } from "@opencraft/ssh-http-ingress/keys";
import { ActorSshKeyRefusal, sshKeyOperator, validKeyName, type ActorSshKeys } from "./actor-ssh-keys.js";

/**
 * Adoption of an existing per-person SSH key store (docs/architecture/identity/personal-ssh-keys.md).
 *
 * The neutral import document a deployment exports from its own store:
 *
 *     { "format": 1, "source": "label",
 *       "keys": [{ "actorId": "human://…" | "binding": { "provider", "subject" },
 *                  "name": "laptop", "publicKey": "ssh-ed25519 AAAA…",
 *                  "createdAt": 1700000000000, "actorGeneration": 3 }] }
 *
 * Only public keys are read. Each entry is validated, resolved to a current Human
 * Actor and added through the same owner as any other key, so duplicates,
 * limits and the audit apply unchanged. Re-running an import is idempotent.
 */
export interface SshKeyImportEntry {
  readonly actorId?: string;
  readonly binding?: { readonly provider: string; readonly subject: string };
  readonly name?: string;
  readonly publicKey: string;
  readonly createdAt?: number;
  /** The Actor generation the source store recorded; a different current generation is refused. */
  readonly actorGeneration?: number;
}
export interface SshKeyImportDocument {
  readonly source: string;
  readonly keys: readonly SshKeyImportEntry[];
}
export type SshKeyImportOutcome =
  "imported" | "would-import" | "already-present" | "unknown-actor" | "stale-generation" | ActorSshKeyRefusal["code"];
export interface SshKeyImportResult {
  readonly index: number;
  readonly outcome: SshKeyImportOutcome;
  readonly actorId: string | null;
  readonly fingerprint: string | null;
}

const ENTRY_FIELDS = new Set(["actorId", "binding", "name", "publicKey", "createdAt", "actorGeneration"]);

/** Validates the document shape at the boundary; key contents are validated per entry. */
export function parseSshKeyImport(value: unknown): SshKeyImportDocument {
  // Annotated so control flow treats each call as an exit.
  const fail: () => never = () => {
    throw new Error("Invalid SSH key import document");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["format", "source", "keys"].includes(key)) || input.format !== 1) fail();
  if (typeof input.source !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(input.source)) fail();
  if (!Array.isArray(input.keys) || input.keys.length > 10_000) fail();
  const keys = (input.keys as unknown[]).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail();
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !ENTRY_FIELDS.has(key))) fail();
    const binding = row.binding as Record<string, unknown> | undefined;
    if ((row.actorId === undefined) === (binding === undefined)) fail();
    if (row.actorId !== undefined && (typeof row.actorId !== "string" || !row.actorId || row.actorId.length > 512))
      fail();
    if (
      binding !== undefined &&
      (!binding ||
        typeof binding !== "object" ||
        Object.keys(binding).some((key) => key !== "provider" && key !== "subject") ||
        typeof binding.provider !== "string" ||
        !binding.provider ||
        typeof binding.subject !== "string" ||
        !binding.subject)
    )
      fail();
    if (typeof row.publicKey !== "string") fail();
    if (row.name !== undefined && typeof row.name !== "string") fail();
    for (const field of ["createdAt", "actorGeneration"])
      if (row[field] !== undefined && (!Number.isSafeInteger(row[field]) || (row[field] as number) < 0)) fail();
    return row as unknown as SshKeyImportEntry;
  });
  return { source: input.source, keys };
}

/**
 * Imports every entry in order. `resolveActor` maps an entry to an Actor id (or
 * null); `generation` reads the Actor's current generation. With `dryRun`,
 * nothing is written and entries that would be added report `would-import`.
 */
export async function importActorSshKeys(
  keys: ActorSshKeys,
  document: SshKeyImportDocument,
  {
    resolveActor,
    generation,
    dryRun = false,
  }: {
    resolveActor(entry: SshKeyImportEntry): string | null;
    generation(actorId: string): number | null;
    dryRun?: boolean;
  },
): Promise<SshKeyImportResult[]> {
  const results: SshKeyImportResult[] = [];
  const operator = sshKeyOperator.import(document.source);
  for (const [index, entry] of document.keys.entries()) {
    const parsed = parsePersonalPublicKey(entry.publicKey);
    const fingerprint = parsed?.fingerprint ?? null;
    const actorId = resolveActor(entry);
    const report = (outcome: SshKeyImportOutcome) => results.push({ index, outcome, actorId, fingerprint });
    if (!parsed) {
      report("invalid_ssh_key");
      continue;
    }
    if (!actorId || generation(actorId) === null) {
      report("unknown-actor");
      continue;
    }
    if (entry.actorGeneration !== undefined && entry.actorGeneration !== generation(actorId)) {
      report("stale-generation");
      continue;
    }
    const name = entry.name === undefined ? undefined : validKeyName(entry.name);
    if (entry.name !== undefined && !name) {
      report("invalid_key_name");
      continue;
    }
    if (keys.list(actorId).some((key) => key.fingerprint === parsed.fingerprint)) {
      report("already-present");
      continue;
    }
    if (dryRun) {
      report("would-import");
      continue;
    }
    try {
      await keys.add(actorId, { name, publicKey: entry.publicKey }, operator, {
        action: "import",
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
      });
      report("imported");
    } catch (error) {
      if (!(error instanceof ActorSshKeyRefusal)) throw error;
      report(error.code === "key_exists" ? "already-present" : error.code);
      if (error.code === "ssh_keys_unavailable") throw error;
    }
  }
  return results;
}
