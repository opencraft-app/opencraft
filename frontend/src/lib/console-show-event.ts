import {
  createPersistedFeatureState,
  type PersistedFeatureStateHost,
} from "@/lib/persisted-feature-state";

export const CONSOLE_SHOW_EVENT = "lightvela:console-show";
export const CONSOLE_SHOW_STORAGE_KEY = "lightvela:console-show-enabled:v1";

type ConsoleShowController = {
  readonly command: (...args: unknown[]) => boolean;
  readonly original: unknown;
  leases: number;
};

export type ConsoleShowHost = PersistedFeatureStateHost & {
  console: Pick<Console, "info">;
  show?: unknown;
  __LIGHTVELA_CONSOLE_SHOW_CONTROLLER__?: ConsoleShowController;
};

const state = createPersistedFeatureState({
  id: "console-show",
  storageKey: CONSOLE_SHOW_STORAGE_KEY,
  eventName: CONSOLE_SHOW_EVENT,
});

const resolveHost = (host?: ConsoleShowHost | null): ConsoleShowHost | null => (
  host ?? (typeof window === "undefined" ? null : window as ConsoleShowHost)
);

export const isConsoleShowEnabled = (host?: ConsoleShowHost | null): boolean =>
  state.get(resolveHost(host));

export const setConsoleShowEnabled = (
  enabled: boolean,
  host?: ConsoleShowHost | null,
): boolean => state.set(enabled, resolveHost(host));

export const toggleConsoleShow = (host?: ConsoleShowHost | null): boolean =>
  state.toggle(resolveHost(host));

export const subscribeConsoleShow = (
  listener: (enabled: boolean) => void,
  host?: ConsoleShowHost | null,
): (() => void) => state.subscribe(listener, resolveHost(host));

/**
 * Legacy toggle entry. New callers should use `toggleConsoleShow` or the
 * installed shared command; subscribers observe the resulting state and must
 * not toggle again.
 */
export const emitConsoleShowEvent = (host?: ConsoleShowHost | null): boolean =>
  toggleConsoleShow(host);

/** One ref-counted global command; multiple surfaces observe one toggle. */
export const installConsoleShowCommand = (
  host?: ConsoleShowHost | null,
): (() => void) => {
  const target = resolveHost(host);
  if (target === null) return () => undefined;
  let controller = target.__LIGHTVELA_CONSOLE_SHOW_CONTROLLER__;
  if (controller === undefined) {
    const original = target.show;
    const command = () => {
      const enabled = toggleConsoleShow(target);
      target.console.info(enabled ? "隐藏功能入口已显示。" : "隐藏功能入口已收起。");
      return enabled;
    };
    controller = { command, original, leases: 0 };
    target.__LIGHTVELA_CONSOLE_SHOW_CONTROLLER__ = controller;
    target.show = command;
  }
  controller.leases += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = target.__LIGHTVELA_CONSOLE_SHOW_CONTROLLER__;
    if (current !== controller) return;
    current.leases -= 1;
    if (current.leases > 0) return;
    if (target.show === current.command) {
      if (current.original === undefined) delete target.show;
      else target.show = current.original;
    }
    delete target.__LIGHTVELA_CONSOLE_SHOW_CONTROLLER__;
  };
};
