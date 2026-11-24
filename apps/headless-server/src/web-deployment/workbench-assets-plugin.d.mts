export interface WorkbenchAssetsPlugin {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export function readWorkbenchAssetsPlugin(vfs: {
  listFiles(): string[];
  readFile(path: string): Uint8Array;
}): Promise<WorkbenchAssetsPlugin | undefined>;

export function injectWorkbenchAssetsPlugin(html: string, plugin: WorkbenchAssetsPlugin): string;
export function serveWorkbenchAssetsPlugin(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  url: URL,
  plugin: WorkbenchAssetsPlugin,
): boolean;
