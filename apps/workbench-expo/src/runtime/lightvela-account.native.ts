import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { createNativeLoginStorage } from "./native-login-storage";
import * as Crypto from "expo-crypto";
import { createNativeLogin, isNativeLoginCallback, NATIVE_LOGIN_PENDING_KEY } from "./native-login";

import type { LightVelaBotInstance } from "@opencraft/plugin-lightvela-hermes";
import type { MobileLightVelaAccount, MobileLightVelaPhase, MobileLightVelaSnapshot } from "./lightvela-account-types";

const API_BASE = "https://api.lightvela.ai";
const TOKEN_KEY = "vela.lightvela.session-token.v1";
const ACTIVE_BOT_KEY = "vela.lightvela.active-bot.v1";
const pendingStorage = createNativeLoginStorage({
  read: () => SecureStore.getItemAsync(NATIVE_LOGIN_PENDING_KEY),
  write: value => SecureStore.setItemAsync(NATIVE_LOGIN_PENDING_KEY, value),
  remove: () => SecureStore.deleteItemAsync(NATIVE_LOGIN_PENDING_KEY),
});

interface ApiEnvelope<T> { readonly data: T; readonly message?: string; readonly request_id?: string }
interface BotListResponse { readonly items: readonly { readonly created_at: string; readonly instance_id: string; readonly name?: string; readonly status: string }[] }

/** Owns the native LightVela credential and selected physical Bot. */
export function createMobileLightVelaAccount(): MobileLightVelaAccount {
  let disposed = false;
  const login = createNativeLogin({
    random: () => Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, "0")).join(""),
    challenge: async verifier => (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    now: Date.now,
    ...pendingStorage,
    open: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
    exchange: async (input, signal) => {
      const response = await fetch(`${API_BASE}/auth/native/token`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
      });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 503
        ? "Native login is not enabled on the server yet"
        : "Login exchange failed. Please sign in again.");
      const body = await response.json() as { session_token?: unknown };
      if (typeof body.session_token !== "string") throw new Error("Invalid login exchange response");
      return body.session_token;
    },
  }, API_BASE);
  const listeners = new Set<() => void>();
  let token: string | null = null;
  let bots: readonly LightVelaBotInstance[] = [];
  let revision = 0;
  let operation: Promise<void> | null = null;
  let snapshot: MobileLightVelaSnapshot = Object.freeze({ revision, phase: "loading", activeBotId: null, botName: null, error: null });
  const publish = (phase: MobileLightVelaPhase, activeBotId: string | null, error: string | null) => {
    if (disposed) return;
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
      if (disposed) return;
      const initialURL = await Linking.getInitialURL();
      if (initialURL && isNativeLoginCallback(initialURL)) {
        try {
          const received = await login.consume(initialURL);
          if (disposed) return;
          if (received) {
            await SecureStore.setItemAsync(TOKEN_KEY, received);
            token = received;
          }
        } catch (error) {
          // An untrusted or stale deep link cannot suppress a saved session.
          if (token === null) throw error;
        }
      }
      if (disposed) return;
      if (token === null) { publish("anonymous", null, null); return; }
      await refresh();
    }),
    signIn: () => run(async () => {
      publish("loading", null, null);
      const nextToken = await login.signIn();
      if (disposed) return;
      if (nextToken === null) { publish("anonymous", null, null); return; }
      await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
      if (disposed) return;
      token = nextToken;
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
    dispose() { disposed = true; login.dispose(); listeners.clear(); token = null; bots = []; },
  };
}
