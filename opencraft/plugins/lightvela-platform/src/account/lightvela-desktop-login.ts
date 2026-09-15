import type { LightVelaRegion } from "./lightvela-account-contract";

/** Narrow platform port; browser and extension code never own OS protocol APIs. */
export interface LightVelaDesktopAccountPort {
  signIn(region: LightVelaRegion): Promise<{ region: LightVelaRegion; token: string } | null>;
  cancel(): Promise<void>;
  readSession(): Promise<{ region: LightVelaRegion; token: string } | null>;
  clearSession(): Promise<void>;
  signOut?(): Promise<void>;
  request?(input: { url: string; method: string; contentType?: string; body?: Uint8Array }): Promise<{ status: number; contentType: string | null; body: Uint8Array }>;
}

export async function fetchDesktopAccount(port: LightVelaDesktopAccountPort, url: string, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  const request = new Request(url, init);
  const body = init.body == null ? undefined : new Uint8Array(await request.arrayBuffer());
  init.signal?.throwIfAborted();
  const result = await port.request!({ url, method: request.method, contentType: request.headers.get("content-type") ?? undefined, body });
  init.signal?.throwIfAborted();
  return new Response([204, 205, 304].includes(result.status) ? null : new Uint8Array(result.body).buffer, {
    status: result.status, headers: result.contentType ? { "Content-Type": result.contentType } : undefined,
  });
}

export function getLightVelaDesktopAccount(): LightVelaDesktopAccountPort | undefined {
  return (globalThis as typeof globalThis & {
    opencraftDesktop?: { kind?: string; lightvelaAccount?: LightVelaDesktopAccountPort };
  }).opencraftDesktop?.lightvelaAccount;
}

let desktopToken: string | null = null;
/** Only noncredential preferences reach Chromium's origin-scoped disk store. */
export function desktopAccountStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  const key = "vela.lightvela.session-token.v1";
  return {
    getItem: (name: string) => name === key ? desktopToken : storage.getItem(name),
    setItem(name: string, value: string) { if (name === key) desktopToken = value; else storage.setItem(name, value); },
    removeItem(name: string) { if (name === key) desktopToken = null; else storage.removeItem(name); },
  };
}
