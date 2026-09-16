export type WindowCommand = (...args: unknown[]) => unknown;
export type WindowCommandHost = Window & { show?: WindowCommand; hide?: WindowCommand };
type CommandName = "show" | "hide";
type Handler = (next: WindowCommand, ...args: unknown[]) => unknown;
type Entry = { active: boolean; handler: Handler };
type Chain = { host: WindowCommandHost; name: CommandName; original: WindowCommand | undefined; entries: Entry[]; dispatch: WindowCommand };
const chains = new WeakMap<WindowCommand, Chain>();

/** Share only our contiguous show/hide wrappers; a later external owner is never overwritten. */
export function registerWindowCommand(host: WindowCommandHost, name: CommandName, handler: Handler): () => void {
  const current = host[name];
  let chain = current ? chains.get(current) : undefined;
  if (!chain || chain.host !== host || chain.name !== name) {
    const entries: Entry[] = [];
    const dispatch: WindowCommand = (...args) => {
      const snapshot = [...entries];
      const call = (index: number, values: unknown[]): unknown => {
        const entry = snapshot[index];
        if (!entry) return current?.apply(host, values);
        if (!entry.active) return call(index - 1, values);
        return entry.handler((...forwarded) => call(index - 1, forwarded), ...values);
      };
      return call(snapshot.length - 1, args);
    };
    chain = { host, name, original: current, entries, dispatch };
    chains.set(dispatch, chain);
    host[name] = dispatch;
  }
  const entry: Entry = { active: true, handler };
  chain.entries.push(entry);
  return () => {
    if (!entry.active) return;
    entry.active = false;
    chain.entries.splice(chain.entries.indexOf(entry), 1);
    if (chain.entries.length || host[name] !== chain.dispatch) return;
    if (chain.original === undefined) delete host[name];
    else host[name] = chain.original;
  };
}
