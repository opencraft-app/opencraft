import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { GitVaultCipher } from "./employee-git-vault-store.js";
import { GitVaultError } from "./git-vault-error.js";
import type { GitGrantScope } from "./personal-git-protocol.js";

export interface GitVaultGrantCipher {
  grantAuthority(key: Uint8Array, accountMode: "principal" | "actor"): string;
  sealGrant(key: Uint8Array, scope: GitGrantScope): string;
}

/** Derives a 32-byte AES-256-GCM key from an installation/account sealing secret. */
export function deriveGitVaultKey(secret: string, domain = "opencraft.employee-git-vault.v1"): Uint8Array {
  if (!secret) throw new GitVaultError("unavailable", 503);
  return new Uint8Array(createHmac("sha256", Buffer.from(secret, "utf8")).update(domain).digest());
}

/**
 * Runtime-neutral AES-256-GCM cipher (`iv ‖ ciphertext ‖ tag`, 12-byte IV + 16-byte tag)
 * usable in both Node and Cloudflare Workers (`nodejs_compat`).
 */
export function aes256GcmGitVaultCipher(
  material: Uint8Array,
  grants?: GitVaultGrantCipher,
): GitVaultCipher {
  let key: Uint8Array = new Uint8Array(material);
  const live = () => {
    if (key.byteLength !== 32) throw new GitVaultError("unavailable", 503);
    return key;
  };
  return {
    seal(aad, clear) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", live(), iv);
      cipher.setAAD(aad);
      return Buffer.concat([iv, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    },
    open(aad, sealed) {
      const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
      if (data.byteLength < 28) throw new GitVaultError("unavailable", 503);
      const decipher = createDecipheriv("aes-256-gcm", live(), data.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
    },
    grantAuthority(accountMode = "principal") {
      if (!grants) throw new GitVaultError("unavailable", 503);
      return grants.grantAuthority(live(), accountMode);
    },
    sealGrant(scope) {
      if (!grants) throw new GitVaultError("unavailable", 503);
      return grants.sealGrant(live(), scope);
    },
    dispose() {
      key.fill(0);
      key = new Uint8Array(0);
    },
  };
}
