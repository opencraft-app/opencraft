import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import type { LightVelaBotInstance } from "@opencraft/plugin-lightvela-hermes";
import type { MobileLightVelaAccount, MobileLightVelaPhase, MobileLightVelaSnapshot } from "./lightvela-account-types";

const API_BASE = "https://api.lightvela.ai";
const TOKEN_KEY = "vela.lightvela.session-token.v1";
const ACTIVE_BOT_KEY = "vela.lightvela.active-bot.v1";

interface ApiEnvelope<T> { readonly data: T; readonly message?: string; readonly request_id?: string }
interface BotListResponse { readonly items: readonly { readonly created_at: string; readonly instance_id: string; readonly name?: string; readonly status: string }[] }

function tokenFromCallback(urlText: string): string | null {
  const url = new URL(urlText);
  return new URLSearchParams(url.hash.slice(1)).get("session_token")?.trim()
    || url.searchParams.get("session_token")?.trim()
    || null;
}

/** Owns the native LightVela credential and selected physical Bot. */
export function createMobileLightVelaAccount(): MobileLightVelaAccount {
  const listeners = new Set<() => void>();
  let token: string | null = null;
  let bots: readonly LightVelaBotInstance[] = [];
  let revision = 0;
  let operation: Promise<void> | null = null;
  let snapshot: MobileLightVelaSnapshot = Object.freeze({ revision, phase: "loading", activeBotId: null, botName: null, error: null });
  const publish = (phase: MobileLightVelaPhase, activeBotId: string | null, error: string | null) => {
    const botName = bots.find(bot => bot.instanceId === activeBotId)?.name ?? null;
    snapshot = Object.freeze({ revision: ++revision, phase, activeBotId, botName, error });
    for (const listener of listeners) listener();
  };
  const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    if (token === null) throw new Error("Sign in to LightVela first");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${API_BASE}${path}`, { ...init, cache: "no-store", headers });
    const body = await response.json() as ApiEnvelope<T>;
    if (!response.ok) {
      if (response.status === 401) {
        token = null;
        await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(ACTIVE_BOT_KEY)]);
      }
      throw new Error(`${body.message || `HTTP ${response.status}`}${body.request_id ? ` request_id=${body.request_id}` : ""}`);
    }
    return body.data;
  };
  const refresh = async () => {
    const result = await request<BotListResponse>("/v1/instances?page=1&page_size=100");
    bots = result.items.filter(bot => bot.status.toLowerCase() === "running").map(bot => Object.freeze({
      createdAt: bot.created_at, instanceId: bot.instance_id, name: bot.name?.trim() || "Untitled Bot", status: bot.status,
    }));
    if (bots.length === 0) throw new Error("No running LightVela Bot is available");
    const storedBotId = await SecureStore.getItemAsync(ACTIVE_BOT_KEY);
    const activeBotId = [snapshot.activeBotId, storedBotId].find(id => id !== null && bots.some(bot => bot.instanceId === id)) ?? bots[0]?.instanceId ?? null;
    if (activeBotId === null) await SecureStore.deleteItemAsync(ACTIVE_BOT_KEY);
    else await SecureStore.setItemAsync(ACTIVE_BOT_KEY, activeBotId);
    publish("authenticated", activeBotId, null);
  };
  const run = (task: () => Promise<void>) => {
    if (operation !== null) return operation;
    const current = task().catch(error => {
      publish(token === null ? "anonymous" : "error", null, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { if (operation === current) operation = null; });
    operation = current;
    return current;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize: () => run(async () => {
      token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (token === null) { publish("anonymous", null, null); return; }
      await refresh();
    }),
    signIn: () => run(async () => {
      const returnTo = Linking.createURL("auth/lightvela");
      const result = await WebBrowser.openAuthSessionAsync(
        `${API_BASE}/auth/oauth/google/start?return_to=${encodeURIComponent(returnTo)}`,
        returnTo,
      );
      if (result.type !== "success") return;
      const nextToken = tokenFromCallback(result.url);
      if (nextToken === null) throw new Error("LightVela login returned without a session token");
      token = nextToken;
      await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
      await refresh();
    }),
    signOut: () => run(async () => {
      token = null; bots = [];
      await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(ACTIVE_BOT_KEY)]);
      publish("anonymous", null, null);
    }),
    retry: () => run(refresh),
    request,
    async resolveActiveBot() {
      if (snapshot.phase !== "authenticated") await run(refresh);
      const bot = bots.find(candidate => candidate.instanceId === snapshot.activeBotId);
      if (bot === undefined) throw new Error("No running LightVela Bot is available");
      return bot;
    },
    dispose() { listeners.clear(); token = null; bots = []; },
  };
}
