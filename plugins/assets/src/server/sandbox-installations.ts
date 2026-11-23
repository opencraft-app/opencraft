/** Provider-typed installation identity for execution credentials. `backend`
 * selects a deployment-registered sandbox provider; the remaining fields belong
 * to that provider. Only E2B is implemented. */
export interface E2BSandboxInstallation {
  readonly backend: "e2b";
  readonly apiUrl: string;
  readonly sandboxUrl: string;
}
export type SandboxInstallation = E2BSandboxInstallation;
export type SandboxBackendId = SandboxInstallation["backend"];
export const SANDBOX_BACKEND_IDS: readonly SandboxBackendId[] = Object.freeze(["e2b"]);
export const isSandboxBackendId = (value: unknown): value is SandboxBackendId =>
  typeof value === "string" && (SANDBOX_BACKEND_IDS as readonly string[]).includes(value);

/** Vault credential: provider installation plus private secret and identity. */
export type SandboxCredential = SandboxInstallation & {
  readonly id: string;
  readonly name: string;
  readonly generation: string;
  readonly apiKey: string;
};

/** Version-1 vault documents predate `backend`; an absent discriminant is E2B.
 * Parse only at this storage boundary. */
export function storedCredentialBackend(raw: Record<string, unknown>): SandboxBackendId {
  if (raw.backend === undefined) return "e2b";
  if (!isSandboxBackendId(raw.backend)) throw Error("Unsupported sandbox backend");
  return raw.backend;
}
/** Persist E2B in its version-1 shape (no `backend`), so stored data written by
 * this version stays readable by earlier readers. Other providers persist it. */
export function storedCredential(credential: SandboxCredential): Record<string, unknown> {
  switch (credential.backend) {
    case "e2b": {
      const { backend: _backend, ...stored } = credential;
      return stored;
    }
  }
}
/** Secret-free provider installation for backend creation. */
export function credentialInstallation(credential: SandboxCredential): SandboxInstallation {
  switch (credential.backend) {
    case "e2b":
      return { backend: "e2b", apiUrl: credential.apiUrl, sandboxUrl: credential.sandboxUrl };
  }
}
/** Provider facts in workspace configuration revisions. The E2B facts keep their
 * original positions so existing persisted revisions remain valid. */
export function credentialRevisionFacts(credential: SandboxCredential): unknown[] {
  switch (credential.backend) {
    case "e2b":
      return [credential.apiUrl, credential.sandboxUrl];
  }
}
