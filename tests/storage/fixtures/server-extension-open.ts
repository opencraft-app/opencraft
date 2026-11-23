// Child-process opener: the Server composition registry is installed once per
// process, so each composition opens the installation in its own process.
import {
  installServerMigrationComposition,
  openServerDatabase,
} from "../../../packages/storage-node/src/server/index.js";
import { composition, type CompositionName } from "./server-extension-compositions.js";

const [name, directory] = process.argv.slice(2) as [CompositionName, string];
if (name !== "core") installServerMigrationComposition(composition(name));
try {
  const owner = await openServerDatabase(directory);
  const result = { outcome: owner.outcome, contract: owner.contract };
  await owner.close();
  console.log(JSON.stringify({ ok: result }));
} catch (error) {
  const failure = error as { kind?: string; message?: string; cause?: unknown };
  console.log(
    JSON.stringify({ error: { kind: failure.kind, message: failure.message, cause: String(failure.cause ?? "") } }),
  );
}
