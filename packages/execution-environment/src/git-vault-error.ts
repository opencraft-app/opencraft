/** Shared domain error without importing the vault's IO/crypto implementation
 * into metadata-only HTTP or Worker clients. The vault re-exports this SAME class. */
export class GitVaultError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "unavailable",
    readonly status = 400,
  ) {
    super(code);
  }
}
