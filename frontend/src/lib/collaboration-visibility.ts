import { useEffect, useSyncExternalStore } from "react";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import {
  CONSOLE_SHOW_STORAGE_KEY,
  installConsoleShowCommand,
  isConsoleShowEnabled,
  setConsoleShowEnabled,
  subscribeConsoleShow,
} from "@/lib/console-show-event";

export const COLLABORATION_SHOWN_KEY = CONSOLE_SHOW_STORAGE_KEY;
export const isCollaborationShown = isConsoleShowEnabled;
export const setCollaborationShown = setConsoleShowEnabled;

export function isCollaborationEnvironment(): boolean {
  return resolveConfiguredAuthApiBaseUrl() === "https://lightclaw.tech";
}

const subscribe = (listener: () => void): (() => void) => subscribeConsoleShow(listener);

/** Join the existing shared show() toggle; never replace the installed command. */
export function useCollaborationShown(): boolean {
  useEffect(() => installConsoleShowCommand(), []);
  return useSyncExternalStore(subscribe, () => isCollaborationEnvironment() && isConsoleShowEnabled(), () => false);
}
