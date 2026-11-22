import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createAssetsStorage } from "../../plugins/assets/src/server/storage.js";
import { githubConnectionProvider } from "../../plugins/assets/src/server/github-provider.js";
// Compiled test composition only. Production Worker data never accepts API URLs.
const origin = process.env.OPENCRAFT_TEST_GITHUB_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw Error("GitHub fixture origin required");
serveWorkerOwner<{ directory: string }>(({ directory }) =>
  createAssetsStorage(directory, [
    githubConnectionProvider(async (url, init) => {
      const request = new URL(String(url));
      if (request.origin !== "https://api.github.com") throw Error("Unexpected remote");
      return fetch(new URL(request.pathname + request.search, origin), init);
    }),
  ]),
);
