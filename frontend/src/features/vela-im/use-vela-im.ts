"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VelaAPI, type AgentRecord, type Identity, type IMMessage, type Session } from "@vela/im-client";
import type { VelaBrowserClient } from "@vela/im-client/browser";
import { resolveVelaImApiBase, velaImRegion } from "./vela-im-env";
import {
  toApplications,
  toContacts,
  toConversations,
  type ApplicationItem,
  type ContactItem,
  type ConversationItem,
} from "./vela-im-model";

export type VelaImStatus = "idle" | "exchanging" | "connecting" | "ready" | "reconnecting" | "offline" | "error";
export type AgentItem = Identity & AgentRecord;

export interface VelaImEvents {
  onMessages?: (messages: IMMessage[]) => void;
  onModified?: (messages: IMMessage[]) => void;
  onRevoked?: (messages: IMMessage[]) => void;
}

interface Connection {
  owner: Session;
  human: Identity;
  ownerApi: VelaAPI;
  client: VelaBrowserClient;
}

/**
 * Owns one natural person's Vela IM presence in the browser: exchanges the LightVela session for the person's
 * stable human identity, connects that identity to Tencent IM through the SDK and mirrors lists the UI needs.
 * The same LightVela account yields the same IM identity on every device.
 */
export function useVelaIm(lightvelaToken: string | null, lightvelaUserID: string | undefined) {
  const [status, setStatus] = useState<VelaImStatus>("idle");
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [applications, setApplications] = useState<ApplicationItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [agentHost, setAgentHost] = useState("none");
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
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    setError("");
    setConnection(null);
    setConversations([]);
    setContacts([]);
    setApplications([]);
    const connect = async () => {
      setStatus("exchanging");
      const owner = await new VelaAPI(base).lightvelaSession(lightvelaToken, velaImRegion());
      if (cancelled) return;
      const human = owner.identities.find((identity) => identity.kind === "human");
      if (!human) throw new Error("没有找到你的 IM 身份");
      const ownerApi = new VelaAPI(base, owner.token);
      void ownerApi.agents().then((r) => {
        if (cancelled) return;
        setAgents(r.agents);
        setAgentHost(r.host);
      }, () => undefined);
      setStatus("connecting");
      const issued = await ownerApi.issueIdentityToken(human.id);
      const { VelaBrowserClient } = await import("@vela/im-client/browser");
      if (cancelled) return;
      local = new VelaBrowserClient(new VelaAPI(base, issued.token));
      await local.connect();
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
      setConnection({ owner, human, ownerApi, client });
      setStatus("ready");
      const [list, friends, apps] = await Promise.allSettled([client.getConversations(), client.getFriends(), client.getFriendApplications()]);
      if (cancelled) return;
      if (list.status === "fulfilled") setConversations(toConversations(list.value));
      if (friends.status === "fulfilled") setContacts(toContacts(friends.value));
      if (apps.status === "fulfilled") setApplications(toApplications(apps.value));
      // UserSigs are short-lived; reconnect well before the identity's IM credential expires.
      renewTimer = setTimeout(() => setGeneration((g) => g + 1), 90 * 60_000);
    };
    const run = lifecycle.current.catch(() => undefined).then(connect);
    lifecycle.current = run;
    void run.catch((e: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String((e as { error?: string })?.error ?? e));
    });
    return () => {
      cancelled = true;
      clearTimeout(renewTimer);
      lifecycle.current = run.catch(() => undefined).then(() => local?.disconnect());
    };
  }, [lightvelaToken, lightvelaUserID, generation]);

  const refreshAgents = useCallback(async () => {
    if (!connection) return;
    const r = await connection.ownerApi.agents();
    setAgents(r.agents);
    setAgentHost(r.host);
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
    agentHost,
    events,
    reconnect,
    refreshAgents,
    refreshContacts,
    refreshConversations,
  };
}

export type VelaImController = ReturnType<typeof useVelaIm>;
