import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createHeadlessAssetsStorage } from "../../apps/headless-server/src/assets-runtime-storage.js";
import { githubConnectionProvider } from "@opencraft/plugin-assets/server/github-provider";
const origin = process.env.OPENCRAFT_TEST_GITHUB_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw Error("Synthetic origin required");
serveWorkerOwner<{ directory: string }>(({ directory }) =>
  createHeadlessAssetsStorage(directory, [
    githubConnectionProvider((url, init) => {
      const remote = new URL(String(url));
      if (remote.origin !== "https://api.github.com") throw Error("Unexpected remote");
      return fetch(new URL(remote.pathname + remote.search, origin), init);
    }),
  ]),
);
