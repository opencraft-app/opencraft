// Published owner migrations of `login-admission.sqlite`. Append version N+1
// through the store's Drizzle flow; never edit a published entry.
const SCHEMA = `
CREATE TABLE login_admission_policies (policy TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, rules TEXT NOT NULL, updated_at INTEGER NOT NULL, operator TEXT NOT NULL) STRICT;
CREATE TABLE login_admission_versions (policy TEXT NOT NULL, revision INTEGER NOT NULL, rules TEXT NOT NULL, at INTEGER NOT NULL, operator TEXT NOT NULL, PRIMARY KEY (policy, revision)) STRICT;
CREATE TABLE login_admission_audit (id INTEGER PRIMARY KEY, policy TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL, operator TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
CREATE INDEX login_admission_audit_policy ON login_admission_audit(policy, id);
CREATE TABLE login_admission_identities (policy TEXT NOT NULL, subject TEXT NOT NULL, attributes TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (policy, subject)) STRICT;
CREATE TABLE login_admission_imports (policy TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (policy, source)) STRICT;
`.trim();

export const LOGIN_ADMISSION_MIGRATIONS = [{ version: 1, name: "login-admission-policy", sql: SCHEMA }] as const;
