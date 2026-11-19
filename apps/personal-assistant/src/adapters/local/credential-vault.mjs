import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../../domain/values.mjs";

/** Local encrypted credentials. Core/agent receive references and metadata only. */
export class LocalCredentialVault {
  constructor(profile, now = Date.now) {
    this.profile = profile;
    this.now = now;
    this.path = join(profile.path, "credentials");
  }
  key() {
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    const file = join(this.path, "key");
    if (!existsSync(file)) {
      try {
        writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    chmodSync(file, 0o600);
    return readFileSync(file);
  }
  read(reference) {
    if (typeof reference !== "string" || !/^[a-f0-9]{64}$/.test(reference))
      throw new Error("Invalid credential reference");
    const row = JSON.parse(readFileSync(join(this.path, `${reference}.json`), "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(`${this.profile.config.assistantId}:${this.profile.config.owner}:${reference}`));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8"),
    );
  }
  put(inputId, kind, provider, secret) {
    if (
      !["secret", "authorization"].includes(kind) ||
      typeof provider !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(provider) ||
      typeof secret !== "string" ||
      !secret.trim() ||
      secret.length > 16000
    )
      throw new Error("Invalid credential input");
    const reference = digest([this.profile.config.assistantId, inputId]);
    if (existsSync(join(this.path, `${reference}.json`))) {
      const old = this.read(reference);
      if (old.kind !== kind || old.provider !== provider || old.secret !== secret)
        throw new Error("Credential identity reused with different intent");
      return this.describe(reference);
    }
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(`${this.profile.config.assistantId}:${this.profile.config.owner}:${reference}`));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          kind,
          provider,
          secret,
          expiresAt: this.now() + 1800000,
        }),
        "utf8",
      ),
      cipher.final(),
    ]);
    writeFileSync(
      join(this.path, `${reference}.json`),
      JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
      { flag: "wx", mode: 0o600 },
    );
    return this.describe(reference);
  }
  describe(reference) {
    let row;
    try {
      row = this.read(reference);
    } catch {
      throw new Error("Credential reference unavailable");
    }
    if (row.expiresAt <= this.now()) throw new Error("Credential has expired");
    return {
      reference,
      kind: row.kind,
      provider: row.provider,
      expiresAt: row.expiresAt,
    };
  }
}
