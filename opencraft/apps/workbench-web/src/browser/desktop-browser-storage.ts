export type BrowserMetadataStorage = Pick<Storage, "getItem" | "setItem">;
interface DesktopStoragePort {
  read(): Promise<Record<string, string>>;
  write(key: string, value: string): Promise<void>;
}
export async function createDesktopBrowserStorage(): Promise<BrowserMetadataStorage> {
  const port = (window as unknown as { opencraftDesktop: { browserState: DesktopStoragePort } }).opencraftDesktop.browserState;
  const values = new Map(Object.entries(await port.read()));
  let pending = Promise.resolve();
  return {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value);
      pending = pending.then(() => port.write(key, value)).catch(() => {
        console.error("[browser] Unable to persist desktop browser metadata");
      });
    },
  };
}
