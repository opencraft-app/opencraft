"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VelaHumanAPI, type BotAgent, type IMMessage } from "@vela/im-client";
import type { VelaBrowserClient } from "@vela/im-client/browser";
import { resolveVelaImApiBase } from "./vela-im-env";
import {
  toApplications,
  toContacts,
  toConversations,
  type ApplicationItem,
  type ContactItem,
  type ConversationItem,
} from "./vela-im-model";

export type VelaImStatus = "idle" | "connecting" | "ready" | "reconnecting" | "offline" | "error";
/** A LightVela bot that has its own IM identity. */
export type AgentItem = BotAgent;

export interface VelaImEvents {
  onMessages?: (messages: IMMessage[]) => void;
  onModified?: (messages: IMMessage[]) => void;
  onRevoked?: (messages: IMMessage[]) => void;
}

interface Connection {
  api: VelaHumanAPI;
  client: VelaBrowserClient;
  selfID: string;
  selfName: string;
}

/**
 * Owns the signed-in person's IM presence in the browser. The existing LightVela login is the only credential: the
 * backend turns it into a one-hour UserSig for this person's stable IM identity, and the SDK renews it on its own.
 */
export function useVelaIm(lightvelaToken: string | null, lightvelaUserID: string | undefined, selfName = "") {
  const [status, setStatus] = useState<VelaImStatus>("idle");
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [applications, setApplications] = useState<ApplicationItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [generation, setGeneration] = useState(0);
  const events = useRef<VelaImEvents>({});
  const lifecycle = useRef<Promise<unknown>>(Promise.resolve());

  const reconnect = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    const base = resolveVelaImApiBase();
    if (!base || !lightvelaToken || !lightvelaUserID) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    let local: VelaBrowserClient | undefined;
    setError("");
    setConnection(null);
    setConversations([]);
    setContacts([]);
    setApplications([]);
    const connect = async () => {
      setStatus("connecting");
      const api = new VelaHumanAPI(base, { headers: () => ({ Authorization: `Bearer ${lightvelaToken}` }) });
      void api.bots().then((list) => { if (!cancelled) setAgents(list); }, () => undefined);
      const { VelaBrowserClient } = await import("@vela/im-client/browser");
      if (cancelled) return;
      local = new VelaBrowserClient();
      await local.connect(() => api.imSession());
      if (cancelled) {
        await local.disconnect();
        return;
      }
      const client = local;
      const observe = (name: string, handler: (event: { data: unknown }) => void) =>
        client.on(name, (event) => {
          if (!cancelled) handler(event);
        });
      observe("CONVERSATION_LIST_UPDATED", (e) => setConversations(toConversations(e.data)));
      observe("FRIEND_LIST_UPDATED", (e) => setContacts(toContacts(e.data)));
      observe("FRIEND_APPLICATION_LIST_UPDATED", () => {
        void client.getFriendApplications().then((list) => setApplications(toApplications(list)), () => undefined);
      });
      observe("MESSAGE_RECEIVED", (e) => events.current.onMessages?.(e.data as IMMessage[]));
      observe("MESSAGE_MODIFIED", (e) => events.current.onModified?.(e.data as IMMessage[]));
      observe("MESSAGE_READ_BY_PEER", (e) => events.current.onModified?.(e.data as IMMessage[]));
      observe("MESSAGE_REVOKED", (e) => events.current.onRevoked?.(e.data as IMMessage[]));
      observe("KICKED_OUT", () => setStatus("offline"));
      observe("SDK_NOT_READY", () => setStatus((s) => (s === "offline" ? s : "reconnecting")));
      observe("SDK_READY", () => setStatus("ready"));
      setConnection({ api, client, selfID: client.userID, selfName });
      setStatus("ready");
      const [list, friends, apps] = await Promise.allSettled([client.getConversations(), client.getFriends(), client.getFriendApplications()]);
      if (cancelled) return;
      if (list.status === "fulfilled") setConversations(toConversations(list.value));
      if (friends.status === "fulfilled") setContacts(toContacts(friends.value));
      if (apps.status === "fulfilled") setApplications(toApplications(apps.value));
    };
    const run = lifecycle.current.catch(() => undefined).then(connect);
    lifecycle.current = run;
    void run.catch((e: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      lifecycle.current = run.catch(() => undefined).then(() => local?.disconnect());
    };
  }, [lightvelaToken, lightvelaUserID, selfName, generation]);

  const refreshAgents = useCallback(async () => {
    if (!connection) return;
    setAgents(await connection.api.bots());
  }, [connection]);

  const provisioning = agents.some((a) => a.state === "provisioning");
  useEffect(() => {
    if (!provisioning) return;
    const timer = setInterval(() => void refreshAgents().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [provisioning, refreshAgents]);

  const refreshContacts = useCallback(async () => {
    if (!connection) return;
    const [friends, apps] = await Promise.all([connection.client.getFriends(), connection.client.getFriendApplications()]);
    setContacts(toContacts(friends));
    setApplications(toApplications(apps));
  }, [connection]);

  const refreshConversations = useCallback(async () => {
    if (!connection) return;
    setConversations(toConversations(await connection.client.getConversations()));
  }, [connection]);

  return {
    status,
    error,
    connection,
    conversations,
    contacts,
    applications,
    agents,
    events,
    reconnect,
    refreshAgents,
    refreshContacts,
    refreshConversations,
  };
}

export type VelaImController = ReturnType<typeof useVelaIm>;
