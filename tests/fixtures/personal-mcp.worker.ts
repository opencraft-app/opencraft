import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import { createPersonalMcpOwner } from "@opencraft/plugin-assets/server/personal-mcp";
import { createHeadlessExecutionRecords } from "@opencraft/headless-server/assets-execution-records";
import { SYNTHETIC_MCP } from "./personal-mcp-service.js";

/** The vault Worker of an identity composition with one personal MCP service,
 * built only from public entry points. Only this fixture redirects the fixed
 * endpoint to a loopback server. */
serveWorkerOwner<{ directory: string; origin: string }>(({ directory, origin }) => {
  if (new URL(origin).hostname !== "127.0.0.1") throw Error("Loopback fixture required");
  const { execution, sessions, actors } = createHeadlessExecutionRecords({ directory });
  return createAssetsStorage(directory, [], execution, undefined, {
    personalMcp: (vault) =>
      createPersonalMcpOwner({
        vault,
        services: [SYNTHETIC_MCP],
        sessions,
        actors,
        fetcher: (input, init) => {
          if (String(input) !== SYNTHETIC_MCP.endpoint) throw Error("Unexpected MCP endpoint");
          return fetch(origin + "/mcp", init);
        },
      }),
  });
});
