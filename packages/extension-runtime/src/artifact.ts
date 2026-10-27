/** A self-contained module snapshot. Digest validation happens before evaluation. */
export interface ExtensionArtifact {
  readonly format: "esm";
  readonly sha256: string;
  readonly code: string;
}

export function parseExtensionArtifact(value: unknown): ExtensionArtifact {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid extension artifact");
  const artifact = value as Record<string, unknown>;
  if (artifact.format !== "esm" || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || typeof artifact.code !== "string" || new TextEncoder().encode(artifact.code).length > 512 * 1024) {
    throw new TypeError("Extension artifact requires ESM, SHA-256 and at most 512 KiB of code");
  }
  return Object.freeze({ format: "esm", sha256: artifact.sha256, code: artifact.code });
}
