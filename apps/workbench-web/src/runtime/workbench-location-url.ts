import {
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  type WorkbenchLocation,
} from "@opencraft/workbench-runtime/workbench-location";
import { serverPath } from "./server-context";

export function parseWorkbenchLocationUrl(url: URL): WorkbenchLocation | null {
  url = new URL(url);
  url.pathname = serverPath(url.pathname);
  const hostId = url.searchParams.get("hostId");
  if (hostId === null || hostId.trim().length === 0) return null;
  const localMatch = /^\/local\/([^/]+)\/?$/u.exec(url.pathname);
  if (localMatch !== null) {
    try {
      return createWorkbenchThreadLocation(hostId, decodeURIComponent(localMatch[1]!));
    } catch {
      return null;
    }
  }
  const draftId = url.searchParams.get("draftId");
  if (url.pathname === "/" && draftId !== null) {
    try {
      return createWorkbenchDraftLocation(hostId, draftId);
    } catch {
      return null;
    }
  }
  return null;
}
