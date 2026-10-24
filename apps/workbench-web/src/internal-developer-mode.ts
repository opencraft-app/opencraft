import { useSyncExternalStore } from "react";

const INTERNAL_DEVELOPER_MODE_SESSION_KEY = "opencraft.internal-developer-mode.v1";
export const INTERNAL_DEVELOPER_MODE_ESCAPE_COUNT = 5;
export const INTERNAL_DEVELOPER_MODE_MAX_GAP_MS = 1_250;
export const INTERNAL_DEVELOPER_MODE_QUERY_PARAM = "opencraft-dev";
export const INTERNAL_DEVELOPER_MODE_TITLE_TAP_COUNT = 7;
export const INTERNAL_DEVELOPER_MODE_TITLE_TAP_WINDOW_MS = 3_000;

export interface EscapeSequenceState {
  readonly count: number;
  readonly lastPressAt: number | null;
}

export interface EscapeSequenceResult {
  readonly state: EscapeSequenceState;
  readonly unlocked: boolean;
}

export interface TitleTapSequenceState {
  readonly count: number;
  readonly firstTapAt: number | null;
}

export interface TitleTapSequenceResult {
  readonly state: TitleTapSequenceState;
  readonly toggled: boolean;
}

export function isInternalAudienceVisible(
  audience: "public" | "internal" | undefined,
  internalDeveloperMode: boolean,
): boolean {
  return audience !== "internal" || internalDeveloperMode;
}

export const EMPTY_ESCAPE_SEQUENCE: EscapeSequenceState = Object.freeze({
  count: 0,
  lastPressAt: null,
});

export const EMPTY_TITLE_TAP_SEQUENCE: TitleTapSequenceState = Object.freeze({
  count: 0,
  firstTapAt: null,
});

/** Pure transition used by the one Workbench-owned global gesture listener. */
export function advanceInternalDeveloperModeGesture(
  state: EscapeSequenceState,
  input: { readonly key: string; readonly repeat: boolean; readonly now: number },
): EscapeSequenceResult {
  if (input.repeat) return { state, unlocked: false };
  if (input.key !== "Escape") return { state: EMPTY_ESCAPE_SEQUENCE, unlocked: false };

  const insideSequence = state.lastPressAt !== null
    && input.now - state.lastPressAt >= 0
    && input.now - state.lastPressAt <= INTERNAL_DEVELOPER_MODE_MAX_GAP_MS;
  const count = insideSequence ? state.count + 1 : 1;
  if (count >= INTERNAL_DEVELOPER_MODE_ESCAPE_COUNT) {
    return { state: EMPTY_ESCAPE_SEQUENCE, unlocked: true };
  }
  return {
    state: { count, lastPressAt: input.now },
    unlocked: false,
  };
}

/** Seven taps within three seconds on the Settings heading toggles the same session flag. */
export function advanceInternalDeveloperModeTitleTaps(
  state: TitleTapSequenceState,
  now: number,
): TitleTapSequenceResult {
  const insideWindow = state.firstTapAt !== null
    && now - state.firstTapAt >= 0
    && now - state.firstTapAt <= INTERNAL_DEVELOPER_MODE_TITLE_TAP_WINDOW_MS;
  const count = insideWindow ? state.count + 1 : 1;
  const firstTapAt = insideWindow ? state.firstTapAt : now;
  if (count >= INTERNAL_DEVELOPER_MODE_TITLE_TAP_COUNT) {
    return { state: EMPTY_TITLE_TAP_SEQUENCE, toggled: true };
  }
  return {
    state: { count, firstTapAt },
    toggled: false,
  };
}

export function pageUrlWithoutSearchAndHash(href: string, origin?: string): string {
  try {
    const url = new URL(href, origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    const match = /^([^?#]*)/.exec(href);
    return match?.[1] ?? href;
  }
}

export function readInternalDeveloperModeQuery(
  search: string,
): boolean | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get(INTERNAL_DEVELOPER_MODE_QUERY_PARAM);
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

export function stripInternalDeveloperModeQuery(
  href: string,
): { readonly nextHref: string; readonly changed: boolean } {
  try {
    const url = new URL(href);
    if (!url.searchParams.has(INTERNAL_DEVELOPER_MODE_QUERY_PARAM)) {
      return { nextHref: href, changed: false };
    }
    url.searchParams.delete(INTERNAL_DEVELOPER_MODE_QUERY_PARAM);
    return { nextHref: `${url.pathname}${url.search}${url.hash}`, changed: true };
  } catch {
    return { nextHref: href, changed: false };
  }
}

function restoreSessionValue(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(INTERNAL_DEVELOPER_MODE_SESSION_KEY) === "enabled";
  } catch {
    return false;
  }
}

let enabled = restoreSessionValue();
let pendingAnnouncement: "enabled" | "disabled" | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return enabled;
}

function getServerSnapshot(): boolean {
  return false;
}

export function getInternalDeveloperMode(): boolean {
  return enabled;
}

export function takeInternalDeveloperModeAnnouncement(): "enabled" | "disabled" | null {
  const value = pendingAnnouncement;
  pendingAnnouncement = null;
  return value;
}

export function setInternalDeveloperMode(next: boolean): boolean {
  if (enabled === next) return false;
  enabled = next;
  pendingAnnouncement = next ? "enabled" : "disabled";
  try {
    if (next) window.sessionStorage.setItem(INTERNAL_DEVELOPER_MODE_SESSION_KEY, "enabled");
    else window.sessionStorage.removeItem(INTERNAL_DEVELOPER_MODE_SESSION_KEY);
  } catch {
    // Storage availability is optional; the in-memory session still toggles.
  }
  for (const listener of listeners) listener();
  return true;
}

export function toggleInternalDeveloperMode(): "enabled" | "disabled" {
  const next = !enabled;
  setInternalDeveloperMode(next);
  return next ? "enabled" : "disabled";
}

/** Apply `?opencraft-dev=1|0` to the session flag and drop the parameter from the address bar. */
export function consumeInternalDeveloperModeQuery(target: {
  readonly href: string;
  readonly search: string;
  readonly replaceState?: (data: unknown, unused: string, url?: string | null) => void;
} | null = typeof window === "undefined" ? null : {
  href: window.location.href,
  search: window.location.search,
  replaceState: window.history.replaceState.bind(window.history),
}): boolean | null {
  if (target === null) return null;
  const next = readInternalDeveloperModeQuery(target.search);
  if (next !== null) setInternalDeveloperMode(next);
  const stripped = stripInternalDeveloperModeQuery(target.href);
  if (stripped.changed) {
    try {
      target.replaceState?.(null, "", stripped.nextHref);
    } catch {
      // History replacement is best-effort; the session flag is already applied.
    }
  }
  return next;
}

if (typeof window !== "undefined") consumeInternalDeveloperModeQuery();

export function useInternalDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function subscribeInternalDeveloperMode(listener: () => void): () => void {
  return subscribe(listener);
}
