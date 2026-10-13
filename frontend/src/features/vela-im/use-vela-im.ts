"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { platformGroupId, VelaError, VelaHumanAPI, type BotAgent, type IMMessage } from "@vela/im-client";
import type { VelaBrowserClient } from "@vela/im-client/browser";
import { resolveVelaImApiBase } from "./vela-im-env";
import {
  agentStatus,
  applyAgentStatus,
  pruneWorking,
  toApplications,
  toContacts,
  toConversations,
  type ApplicationItem,
  type ContactItem,
  type ConversationItem,
  type WorkingAgents,
} from "./vela-im-model";

export type VelaImStatus = "idle" | "connecting" | "ready" | "reconnecting" | "offline" | "error";
/** A LightVela bot that has its own IM identity. */
export type AgentItem = BotAgent;

const isRestricted = (e: unknown) => e instanceof VelaError && e.code === "im_identity_restricted";

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
  /** An admin restricted this person's IM identity: no session is issued and group chat is unavailable. */
  const [restricted, setRestricted] = useState(false);
  /** The same person signed in on another device, or in more browser tabs than the IM app allows; this one is offline. */
  const [signedInElsewhere, setSignedInElsewhere] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [applications, setApplications] = useState<ApplicationItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  /** The backend's Agent list has arrived; until then an empty list says nothing about which Agents lack an identity. */
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  /** Kept per conversation for the whole session, so switching chats or devices never loses who is working. */
  const [working, setWorking] = useState<WorkingAgents>({});
  /** IM user IDs in each platform group, keyed by Tencent group ID; membership lives in the backend, not in Tencent. */
  const [groupMembers, setGroupMembers] = useState<Record<string, string[]>>({});
  const requestedGroups = useRef(new Set<string>());
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
    setRestricted(false);
    setSignedInElsewhere(false);
    setConnection(null);
    setConversations([]);
    setContacts([]);
    setApplications([]);
    setWorking({});
    setGroupMembers({});
    setAgentsLoaded(false);
    requestedGroups.current = new Set();
    const connect = async () => {
      setStatus("connecting");
      const api = new VelaHumanAPI(base, { headers: () => ({ Authorization: `Bearer ${lightvelaToken}` }) });
      void api.bots().then((list) => { if (!cancelled) { setAgents(list); setAgentsLoaded(true); } }, () => undefined);
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
      observe("MESSAGE_RECEIVED", (e) => {
        const list = (e.data as IMMessage[]) ?? [];
        const signals = list.filter((m) => agentStatus(m));
        if (signals.length) setWorking((old) => applyAgentStatus(old, signals));
        const messages = list.filter((m) => !agentStatus(m));
        if (messages.length) events.current.onMessages?.(messages);
      });
      observe("MESSAGE_MODIFIED", (e) => events.current.onModified?.(e.data as IMMessage[]));
      observe("MESSAGE_READ_BY_PEER", (e) => events.current.onModified?.(e.data as IMMessage[]));
      observe("MESSAGE_REVOKED", (e) => events.current.onRevoked?.(e.data as IMMessage[]));
      observe("KICKED_OUT", (e) => {
        setStatus("offline");
        const type = (e.data as { type?: string } | undefined)?.type;
        if (type === client.TYPES.KICKED_OUT_MULT_ACCOUNT || type === client.TYPES.KICKED_OUT_MULT_DEVICE) {
          setSignedInElsewhere(true);
          return;
        }
        // Restricting someone signs them out at once; ask the backend whether that is why.
        void api.imSession().catch((e: unknown) => { if (!cancelled && isRestricted(e)) setRestricted(true); });
      });
      observe("SDK_NOT_READY", () => setStatus((s) => (s === "offline" ? s : "reconnecting")));
      observe("SDK_READY", () => { setStatus("ready"); setRestricted(false); setSignedInElsewhere(false); });
      setConnection({ api, client, selfID: client.userID, selfName });
      setStatus("ready");
      // Others see this person by their LightVela name, not the backend's placeholder.
      if (selfName.trim()) {
        void client.getMyProfile().then((profile: { nick?: string } | undefined) =>
          profile?.nick === selfName ? undefined : client.updateMyProfile({ nick: selfName })).catch(() => undefined);
      }
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
      if (isRestricted(e)) setRestricted(true);
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
    setAgentsLoaded(true);
  }, [connection]);

  // A restriction applied while the page is open shows up when the person comes back to it.
  useEffect(() => {
    if (!connection) return;
    const onVisible = () => { if (document.visibilityState === "visible") void refreshAgents().catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [connection, refreshAgents]);

  const provisioning = agents.some((a) => a.state === "provisioning");
  useEffect(() => {
    if (!provisioning) return;
    const timer = setInterval(() => void refreshAgents().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [provisioning, refreshAgents]);

  const anyWorking = Object.keys(working).length > 0;
  useEffect(() => {
    if (!anyWorking) return;
    const timer = setInterval(() => setWorking((old) => pruneWorking(old)), 4000);
    return () => clearInterval(timer);
  }, [anyWorking]);

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

  const refreshGroupMembers = useCallback(async (groupID: string) => {
    const id = platformGroupId(groupID);
    if (!connection || !id) return;
    const group = await connection.api.group(id);
    setGroupMembers((old) => ({ ...old, [groupID]: group.members.map((m) => m.userId) }));
  }, [connection]);

  // Reloaded whenever Tencent reports a different member count, so joins and leaves elsewhere show up too.
  const groupKeys = conversations.filter((c) => c.kind === "GROUP").map((c) => `${c.targetID}|${c.memberCount ?? ""}`).join(",");
  useEffect(() => {
    for (const key of groupKeys.split(",").filter(Boolean)) {
      if (requestedGroups.current.has(key)) continue;
      requestedGroups.current.add(key);
      void refreshGroupMembers(key.slice(0, key.lastIndexOf("|"))).catch(() => requestedGroups.current.delete(key));
    }
  }, [groupKeys, refreshGroupMembers]);

  return {
    status,
    error,
    restricted,
    signedInElsewhere,
    connection,
    conversations,
    contacts,
    applications,
    agents,
    agentsLoaded,
    working,
    groupMembers,
    events,
    reconnect,
    refreshAgents,
    refreshContacts,
    refreshConversations,
    refreshGroupMembers,
  };
}

export type VelaImController = ReturnType<typeof useVelaIm>;
