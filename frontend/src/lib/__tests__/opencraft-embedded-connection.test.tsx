import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EmbeddedChatPreparation, useEmbeddedPhysicalConnectionPreparation } from "../opencraft-embedded-connection";
import { AgentChatMigrationSurface } from "@/pages/marketing/opencraft-embedded-workbench";
import { writeStoredAuthToken } from "@/repositories/http-repositories";

const state = vi.hoisted(() => ({
  global: false, userId: "user-1", search: "", current: true,
  discovery: null as { accountId: string; items: { instanceId: string; running: boolean }[]; isCurrent(): boolean } | null,
  session: vi.fn(),
}));
vi.mock("@/lib/region", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/region")>(), get isGlobal() { return state.global; }, isCN: true,
}));
vi.mock("@/contexts/session-context", () => ({ useSession: () => ({ session: { user: { id: state.userId } } }) }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw: () => ({ instanceDiscovery: state.discovery }) }));
vi.mock("@/contexts/repository-context", () => {
  const repositories = { bots: { getTerminalSession: state.session } };
  return { useRepositories: () => repositories };
});
vi.mock("@/lib/app-navigation", () => ({ useAppSearchParams: () => [new URLSearchParams(state.search), vi.fn()] }));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));
let elements = 0;
const configure = vi.fn();
const disposePreparation = vi.fn();
const preparations: Array<{ dispose(): void }> = [];
const preparedOptions: Array<{ assertAuthority(): void; createSession(signal: AbortSignal): Promise<unknown> }> = [];
class Embedded extends HTMLElement {
  static preparePhysicalConnection(options: typeof preparedOptions[number]) {
    const value = { dispose: disposePreparation };
    preparations.push(value);
    preparedOptions.push(options);
    void options.createSession(new AbortController().signal).catch(() => {});
    return value;
  }
  constructor() { super(); elements++; }
  configure = configure;
  prepare = async () => {};
  show = async () => {};
  hide = () => {};
  dispose = async () => {};
  createConversation = async () => {};
}
let observed: ReturnType<typeof useEmbeddedPhysicalConnectionPreparation>;
function Probe() { observed = useEmbeddedPhysicalConnectionPreparation(); return null; }
function Page({ active = true, botReady = false }: { active?: boolean; botReady?: boolean }) {
  return <EmbeddedChatPreparation active={active}>
    {React.createElement(Probe)}
    {botReady ? <AgentChatMigrationSurface active enabled accountId={state.userId} apiBase="https://api.example"
      instanceId="ins-1" profileId="sales" region="cn" legacy={null}
      multiSession={{ onSessionStateChange: () => {}, onSelectedChatIdChange: () => {} }} /> : null}
  </EmbeddedChatPreparation>;
}
beforeEach(() => {
  Object.assign(state, { global: false, userId: "user-1", search: "", current: true });
  state.discovery = { accountId: "user-1", items: [{ instanceId: "ins-1", running: true }], isCurrent: () => state.current };
  state.session.mockReset().mockResolvedValue({});
  preparations.length = 0; preparedOptions.length = 0; elements = 0;
  configure.mockClear(); disposePreparation.mockClear();
  vi.stubEnv("NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL", "/__opencraft/embedded-workbench.js");
  vi.stubEnv("NEXT_PUBLIC_AUTH_API_BASE_URL", "https://api.example");
  writeStoredAuthToken("synthetic-session");
  if (!customElements.get("opencraft-embedded-workbench")) customElements.define("opencraft-embedded-workbench", Embedded);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllEnvs(); });

it("starts session preparation while Profiles are held, then gives the one surface the same capability", async () => {
  const view = render(<Page />);
  await waitFor(() => expect(state.session).toHaveBeenCalledOnce());
  expect(elements).toBe(0);
  expect(observed).toBe(preparations[0]);
  expect(state.session).toHaveBeenCalledWith("ins-1", expect.objectContaining({ signal: expect.any(AbortSignal), suppressUnauthorizedBroadcast: true }));
  view.rerender(<Page botReady />);
  await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ physicalConnection: preparations[0], profileId: "sales" })));
  expect(elements).toBe(1);
  expect(state.session).toHaveBeenCalledOnce();
  view.rerender(<Page botReady />);
  expect(elements).toBe(1);
});

it.each(["inactive", "international", "stale", "wrong-account", "paused", "ambiguous"])("does not speculate for %s", async kind => {
  if (kind === "international") state.global = true;
  if (kind === "stale") state.current = false;
  if (kind === "wrong-account") state.userId = "user-2";
  if (kind === "paused") state.discovery!.items[0]!.running = false;
  if (kind === "ambiguous") { state.discovery!.items.push({ instanceId: "ins-2", running: true }); state.search = "?bot=unknown-profile"; }
  render(<Page active={kind !== "inactive"} />);
  await act(async () => { await Promise.resolve(); });
  expect(state.session).not.toHaveBeenCalled();
  expect(elements).toBe(0);
});

it("uses a verified explicit root instance among several machines", async () => {
  state.discovery!.items.push({ instanceId: "ins-2", running: true });
  state.search = "?bot=ins-2";
  render(<Page />);
  await waitFor(() => expect(state.session).toHaveBeenCalledWith("ins-2", expect.any(Object)));
});

it("keeps ordinary Surface startup when an independently deployed artifact has no preparation API", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Embedded, "preparePhysicalConnection")!;
  Object.defineProperty(Embedded, "preparePhysicalConnection", { configurable: true, value: undefined });
  try {
    render(<Page botReady />);
    await waitFor(() => expect(configure).toHaveBeenCalledOnce());
    expect(state.session).not.toHaveBeenCalled();
    expect(observed).toBeNull();
    expect(elements).toBe(1);
    expect(configure.mock.calls[0]![0].physicalConnection).toBeUndefined();
  } finally {
    cleanup();
    Object.defineProperty(Embedded, "preparePhysicalConnection", descriptor);
  }
});

it("does not warm an unrelated running machine when the selected root is paused", async () => {
  state.discovery!.items.push({ instanceId: "ins-paused", running: false });
  state.search = "?bot=ins-paused";
  render(<Page />);
  await act(async () => { await Promise.resolve(); });
  expect(state.session).not.toHaveBeenCalled();
});

it("route retirement releases preparation and fences its borrowed session accessor", async () => {
  const view = render(<Page />);
  await waitFor(() => expect(preparedOptions).toHaveLength(1));
  view.rerender(<Page active={false} />);
  expect(disposePreparation).toHaveBeenCalledOnce();
  expect(() => preparedOptions[0]!.assertAuthority()).toThrow();
});

it("session replacement synchronously releases preparation before any new Surface can borrow it", async () => {
  render(<Page />);
  await waitFor(() => expect(preparedOptions).toHaveLength(1));
  act(() => writeStoredAuthToken("new-synthetic-session"));
  expect(disposePreparation).toHaveBeenCalledOnce();
  expect(() => preparedOptions[0]!.assertAuthority()).toThrow();
  expect(observed).toBeNull();
});
