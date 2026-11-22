import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { GitVaultCredential } from "./employee-git-vault-store.js";
export function sshString(value: string | Uint8Array): Buffer {
  const bytes = Buffer.from(value),
    size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}
export function generateGitSigningKey(): NonNullable<GitVaultCredential["signing"]> {
  const pair = generateKeyPairSync("ed25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.from(publicJwk.x!, "base64url"))]);
  return {
    generation: randomUUID(),
    publicKey: `ssh-ed25519 ${blob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`,
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    registration: "pending",
  };
}
