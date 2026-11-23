import type { SqlDatabase } from "@opencraft/sql";
import type { LocalAccountPasswordExpectation } from "@opencraft/identity-core/local-account";

/**
 * The login-time password record upgrade, for the Server owner Worker only (its
 * entry passes this to `IdentityWriteOwner`; no network thread imports it).
 * Compare-and-set: applies only while the account is enabled and still holds the
 * verified version and record; no version bump, so existing logins stay valid
 * and a concurrent password change (which bumps the version) wins.
 */
export function localAccountPasswordUpgrade(database: SqlDatabase) {
  const upgrade = database.prepare(
    "UPDATE local_accounts SET salt=?, password_digest=? WHERE id=? AND enabled=1 AND version=? AND salt=? AND password_digest=?",
  );
  return (id: string, expected: LocalAccountPasswordExpectation, salt: string, passwordDigest: string): boolean =>
    upgrade.run(salt, passwordDigest, id, expected.version, expected.salt, expected.passwordDigest).changes > 0;
}
