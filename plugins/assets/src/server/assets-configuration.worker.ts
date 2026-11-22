import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createAssetsStorage } from "./storage.js";
serveWorkerOwner<{ directory: string }>(({ directory }) => createAssetsStorage(directory));
