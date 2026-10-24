import { join, resolve } from "node:path";
import { AccountPoolStore } from "../packages/account-pool-host/src/store.js";
import { acquireCodexWriter } from "../packages/account-pool-host/src/codex-writer-lock.js";
import { readCodexAuthFile } from "../packages/account-pool-host/src/codex-auth-file.js";

// Local operator command only. No RPC accepts arbitrary server file paths.
const [dataDirectory, authPath, id = "shared-codex"] = process.argv.slice(2);
if (!dataDirectory || !authPath) throw new Error("Usage: codex-account-reference <codex-data-directory> <shared-auth.json> [account-id]");
const root = resolve(dataDirectory);
const reference = { kind: "codex-auth-file" as const, path: resolve(authPath) };
const release = await acquireCodexWriter(root);
try {
  const { accountId } = readCodexAuthFile(reference);
  const store = new AccountPoolStore({ databasePath: join(root, "account-pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    store.addAccount({ id, provider: "codex", label: "Shared Codex account", upstreamAccountId: accountId,
      priority: store.listAccounts().length + 1, enabled: true }, reference);
    console.log(JSON.stringify({ configured: true, credentialSource: "external-file", tokensCopied: false }));
  } finally { store.close(); }
} finally { release(); }
