// Node owner of the employee Git vault (the `./employee-git-vault-store` export).
// It keeps everything that is a Node deployment fact: the private 0700
// directory and 0600 file checks, the installation key through KeyMaterial,
// openManagedDatabase on `employee-git-vault.sqlite` (published migration and
// checksum unchanged) and AES-256-GCM through node:crypto. The vault rows,
// revisions and envelopes are the runtime-neutral EmployeeGitVault.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createSchemaValidator,
  nodeSqlDatabase,
  openManagedDatabase,
  type DatabaseOutcome,
} from "@opencraft/sqlite-node";
import { fileKeyMaterial } from "@opencraft/secret-storage/file";
import { gitGrantAuthority, sealGitGrant } from "./personal-git-protocol.js";
import {
  EMPLOYEE_GIT_VAULT_KEY,
  EMPLOYEE_GIT_VAULT_MIGRATIONS,
  EmployeeGitVault,
  type GitVaultCipher,
} from "./employee-git-vault-store.js";
import { aes256GcmGitVaultCipher } from "./git-vault-cipher.js";
import { GitVaultError } from "./git-vault-error.js";

export * from "./employee-git-vault-store.js";

/** Opens (creating when absent) the private database file and reports whether it is still empty. */
async function privateFile(path: string): Promise<{ fresh: boolean }> {
  const file = await open(path, constants.O_NOFOLLOW | constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      throw new GitVaultError("unavailable", 503);
    return { fresh: st.size === 0 };
  } finally {
    await file.close();
  }
}

/** AES-256-GCM with a 12-byte IV and 16-byte tag: `iv ‖ ciphertext ‖ tag`, the vault's original layout. */
export function nodeGitVaultCipher(key: Buffer): GitVaultCipher {
  const cipher = aes256GcmGitVaultCipher(key, {
    grantAuthority: (liveKey, accountMode) => gitGrantAuthority(liveKey, accountMode),
    sealGrant: (liveKey, scope) => sealGitGrant(liveKey, scope),
  });
  return {
    ...cipher,
    dispose() {
      cipher.dispose();
      key.fill(0);
    },
  };
}

/** Opaque account scope is supplied by the verified identity provider, never by a browser body. */
export class EmployeeGitVaultStore extends EmployeeGitVault {
  readonly outcome: DatabaseOutcome;
  /**
   * The key is resolved before the database is opened: a freshly created
   * database may create it once; an existing database only reads it, so a
   * missing key is a recovery error and never orphans encrypted rows.
   */
  static async open(directory: string): Promise<EmployeeGitVaultStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Managed deployments may retain a data-directory alias after migration.
    // Pin its canonical directory once; key/database files still use NOFOLLOW.
    const physicalDirectory = await realpath(directory);
    const dir = await open(physicalDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await dir.stat();
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
        throw new GitVaultError("unavailable", 503);
    } finally {
      await dir.close();
    }
    const path = join(physicalDirectory, "employee-git-vault.sqlite");
    const { fresh } = await privateFile(path);
    const keys = fileKeyMaterial(physicalDirectory);
    let material: Uint8Array | undefined;
    try {
      // A nonempty database without its original key is a recovery error.
      material = fresh
        ? await keys.ensure(EMPLOYEE_GIT_VAULT_KEY, () => randomBytes(32))
        : await keys.read(EMPLOYEE_GIT_VAULT_KEY);
    } catch (cause) {
      throw Object.assign(new GitVaultError("unavailable", 503), { cause });
    }
    if (!material) throw new GitVaultError("unavailable", 503);
    const key = Buffer.from(material.buffer, material.byteOffset, material.byteLength);
    if (key.length !== 32) {
      key.fill(0);
      throw new GitVaultError("unavailable", 503);
    }
    const cipher = nodeGitVaultCipher(key);
    let managed: ReturnType<typeof openManagedDatabase>;
    try {
      managed = openManagedDatabase({
        schemaId: "employee-git-vault-store",
        path,
        migrations: EMPLOYEE_GIT_VAULT_MIGRATIONS,
        validateSchema: createSchemaValidator(EMPLOYEE_GIT_VAULT_MIGRATIONS[0].sql),
        legacyPolicy: "reject",
      });
    } catch (error) {
      cipher.dispose();
      throw error;
    }
    return new EmployeeGitVaultStore(managed.database, managed.outcome, cipher);
  }
  private constructor(
    connection: ReturnType<typeof openManagedDatabase>["database"],
    outcome: DatabaseOutcome,
    cipher: GitVaultCipher,
  ) {
    super(nodeSqlDatabase(connection), cipher, () => connection.close());
    this.outcome = outcome;
  }
}
