import { afterEach, expect, it, vi } from "vitest";
import { createHttpRepositories, AUTH_UNAUTHORIZED_EVENT, writeStoredAuthToken } from "../http-repositories";

const envelope = (data: unknown) => new Response(JSON.stringify({ code: "OK", data }), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); vi.restoreAllMocks(); });

it("publishes the same verified physical instance read before the held Profile catalog", async () => {
  let release!: (response: Response) => void;
  const profiles = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.fn().mockImplementation((url: string) => url.endsWith("/bots") ? profiles : Promise.resolve(envelope({ items: [
    { instance_id: "ins-1", status: "Running", created_at: "2026-10-05" },
    { instance_id: "ins-2", status: "Paused", created_at: "2026-10-05" },
  ] })));
  vi.stubGlobal("fetch", fetch);
  const discovered = vi.fn();
  let completed = false;
  const reading = createHttpRepositories("https://api.example").bots.getDashboardSnapshot("live", { onInstances: discovered });
  void reading.then(() => { completed = true; }, () => {});
  await vi.waitFor(() => expect(discovered).toHaveBeenCalledWith([
    { instanceId: "ins-1", running: true }, { instanceId: "ins-2", running: false },
  ]));
  expect(completed).toBe(false);
  expect(fetch.mock.calls.filter(([url]) => url === "https://api.example/v1/instances")).toHaveLength(1);
  release(envelope({ items: [{ bot_id: "bot-sales", instance_id: "ins-1", profile_id: "sales", name: "Sales", status: "ready", created_at: "2026-10-05" }] }));
  expect((await reading).bots.some(bot => bot.id === "bot-sales")).toBe(true);
});

it("aborted preparation does not create a session after asynchronous scope resolution", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const session = createHttpRepositories("https://api.example").bots.getTerminalSession("ins-1", { signal: controller.signal });
  controller.abort();
  await expect(session).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

it("a speculative unauthorized result never broadcasts logout into a newer session", async () => {
  writeStoredAuthToken("synthetic-old-session");
  let release!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const unauthorized = vi.fn();
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
  try {
    const session = createHttpRepositories("https://api.example").bots.getTerminalSession("ins-1", { suppressUnauthorizedBroadcast: true });
    const rejected = expect(session).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    writeStoredAuthToken("synthetic-new-session");
    release(new Response(JSON.stringify({ message: "expired" }), { status: 401 }));
    await rejected;
    expect(unauthorized).not.toHaveBeenCalled();
  } finally { window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized); }
});
