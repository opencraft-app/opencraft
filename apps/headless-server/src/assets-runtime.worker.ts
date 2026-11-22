import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createHeadlessAssetsStorage } from "./assets-runtime-storage.js";
serveWorkerOwner<{ directory: string }>(({ directory }) => createHeadlessAssetsStorage(directory));
