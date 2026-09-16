export const CONSOLE_SHOW_EVENT = "lightvela:console-show";

export const emitConsoleShowEvent = (): void => {
  window.dispatchEvent(new Event(CONSOLE_SHOW_EVENT));
};
