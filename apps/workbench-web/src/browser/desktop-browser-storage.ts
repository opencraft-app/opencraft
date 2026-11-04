import { createLocalBrowserStorage } from './local-browser-records';
export type BrowserRecordCollection = 'pages' | 'tabs' | 'storage' | 'bindings';
export interface BrowserMetadataRecord { collection: BrowserRecordCollection; id: string; revision: number; value: any | null }
export interface BrowserRecordPort {
  rows(collection: BrowserRecordCollection): readonly BrowserMetadataRecord[];
  get(collection: BrowserRecordCollection, id: string): BrowserMetadataRecord | null;
  put(collection: BrowserRecordCollection, id: string, value: unknown): void;
  remove(collection: BrowserRecordCollection, id: string): void;
  flushPage?(pageId:string):Promise<void>;
  flush(refs?: readonly {collection:BrowserRecordCollection;id:string}[]): Promise<void>;
}
export interface RemoteBrowserResource {
  sessionId: string; lease: string; lifecycle: string; runtime: string; url: string | null;
  link: { pageId: string; tabId: string; scopeId: string; hostId: string | null } | null;
  createdAt: number | null;
}
export interface RemoteBrowserCatalog {
  sessions: RemoteBrowserResource[];
  capacity: { used: number; limit: number; accountUsed: number; accountLimit: number };
}
export type BrowserMetadataStorage = Pick<Storage, "getItem" | "setItem"> & {
  records?: BrowserRecordPort;
  dispose?(): void | Promise<void>;
  flush?(): Promise<void>;
  listResources?(): Promise<RemoteBrowserCatalog>;
  closeResource?(lease: string): Promise<void>;
};
interface DesktopStoragePort {
  read(): Promise<Record<string, string>>;
  write(key: string, value: string): Promise<void>;
}
export async function createDesktopBrowserStorage(namespace?:string): Promise<BrowserMetadataStorage> {
  const port = (window as unknown as { opencraftDesktop: { browserState: DesktopStoragePort } }).opencraftDesktop.browserState;
  return createLocalBrowserStorage({namespace,legacy:()=>port.read()});
}
