export declare const PERSONAL_KEY_ALGORITHMS: readonly string[];
export interface PersonalPublicKey {
  readonly algorithm: string;
  /** Normalized `<algorithm> <base64>` without the comment. */
  readonly publicKey: string;
  /** OpenSSH `SHA256:` fingerprint of the key blob. */
  readonly fingerprint: string;
  readonly comment: string | null;
}
export declare function parsePersonalPublicKey(value: unknown): PersonalPublicKey | null;
export declare function sshPublicKeyFingerprint(blob: Uint8Array): string;
