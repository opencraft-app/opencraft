import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

/** Read-only Harness opens paused; usage() does not resume native scheduling. */
export async function readNativeUsage(path, models) {
  const storage = await openNodeSqliteStorage(path);
  let harness;
  try {
    harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
    return await harness.usage(context);
  } finally {
    if (harness) await harness.close(context);
    else await storage.close(context);
  }
}
