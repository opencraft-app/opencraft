export interface BrowserProcessTarget {
  process?: { env?: Record<string, unknown> };
}

export function ensureBrowserProcessEnv(target: BrowserProcessTarget): void {
  if (target.process === undefined) {
    target.process = { env: {} };
    return;
  }
  target.process.env ??= {};
}
