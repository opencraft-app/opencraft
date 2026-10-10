/** A Host denial must not fall through to the operating-system URL opener. */
export function nativeLinkOpenRoute(options: {
  readonly allowed: boolean;
  readonly target: string | null;
  readonly hasHostOpener: boolean;
  readonly hostAllowsOpen: boolean;
}): "host" | "system" | null {
  if (!options.allowed || options.target === null || !options.hostAllowsOpen) return null;
  if (options.hasHostOpener) return "host";
  return /^(?:https?:|mailto:|tel:|sms:|\/\/)/iu.test(options.target) ? "system" : null;
}
