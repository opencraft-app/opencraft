import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Switchboard } from "@opencraft/plugin-im/switchboard";
import { IM_REPLY_TOOL } from "@opencraft/plugin-im/reply-tool";
import { IM_READ_TOOLS } from "@opencraft/plugin-im/read-tools";
import { ImPostReceipts } from "@opencraft/plugin-im/post-receipts";
import { ChannelSync } from "@opencraft/plugin-im/channel-sync";
import { CHANNEL_IMAGE_LIMIT, CHANNEL_IMAGE_TYPES } from "@opencraft/appserver-protocol/channel-images";
import { ImWeComPosts } from "./im-wecom-posts.mjs";
import { WECOM_POST_TOOL } from "@opencraft/plugin-wecom/post-tool";
import { ImWeComHistory } from "./im-wecom-history.mjs";
import { WECOM_HISTORY_TOOLS } from "@opencraft/plugin-wecom/history";
import { ImPlugin } from "@opencraft/plugin-im/server";
import {
  compileRoute,
  evaluateRoute,
  routeSource,
  sourceRoute,
} from "@opencraft/plugin-im/routing";
import { WeComPlugin } from "@opencraft/plugin-wecom/server";
import { SlackPlugin, slackApi } from "@opencraft/plugin-slack/server";
import { ModelCredentialRepository } from "@opencraft/local-agent-host/model-config/repository";
import { fileSecretStore } from "@opencraft/secret-storage/file";
import { createImExecution } from "./im-plugins.mjs";
import { groupCreateOptions } from "@opencraft/access-control/communication-extension";

const digest = (v) => createHash("sha256").update(v).digest("hex");
const credential = (id, key) => "IM_" + digest(id).slice(0, 32) + "_" + key;
const id = (v) => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > 512 ||
    /[\x00-\x1f\x7f]/u.test(v)
  )
    throw Error("invalid_input");
  return v;
};
const object = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("invalid_input");
  return v;
};
const fields = (v, keys) => {
  object(v);
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw Error("invalid_input");
};
const secret = (v) => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > 4096 ||
    /[\r\n\0]/u.test(v)
  )
    throw Error("invalid_credentials");
  return v;
};

function channelTransports(dependencies) {
  if(dependencies.channelSync != null && dependencies.channelSyncs != null)throw Error('Conflicting channel composition');
  const transports=dependencies.channelSyncs ?? (dependencies.channelSync ? [dependencies.channelSync] : []);
  if(!Array.isArray(transports))throw Error('Invalid channel composition');
  const ids=new Set(),routes=new Set(),sources=new Set(),channels=new Set();
  for(const transport of transports) {
    const connectionId=ChannelSync.validateTransport(transport);
    if(ids.has(connectionId))throw Error('Duplicate channel connection ID');
    ids.add(connectionId);
    if(transport.callback) {
      if(routes.has(transport.callback.path))throw Error('Duplicate channel callback route');
      routes.add(transport.callback.path);
    }
    for(const binding of transport.bindings) {
      if(sources.has(binding.source)||channels.has(binding.channelId))throw Error('Duplicate channel source binding');
      sources.add(binding.source);channels.add(binding.channelId);
    }
  }
  return [...transports];
}

/** Composition owns credentials and platform transports. IM sees only verified humans and delivery ports. */
export class ImChannelService {
  static async open(endpoints, dependencies) {
    const transports = channelTransports(dependencies);
    let service;
    let attempted = 0;
    try {
      // The switchboard database is owned by a Worker; this thread reads its projection.
      const store = await Switchboard.open(join(dependencies.dataDirectory, "im-switchboard.sqlite"));
      try {
        service = new ImChannelService(dependencies, store);
      } catch (error) {
        await store.close().catch(() => {});
        throw error;
      }
      for (const transport of transports) {
        attempted++;
        service.channelSyncs.push(await ChannelSync.open(transport, dependencies.collaboration));
        if(transport.callback)service.channelCallbacks.set(transport.callback.path,transport.callback.handle.bind(transport.callback));
      }
      if (!transports.length && dependencies.collaboration?.synchronizeChannels) {
        await dependencies.collaboration.synchronizeChannels({method:'configure',params:{incarnation:randomUUID(),bindings:[],images:false}});
      }
      for (const endpoint of endpoints) {
        if (!service.store.hasChannel(endpoint.id)) {
          await service.credentials.set(
            credential(endpoint.id, "secret"),
            endpoint.secret,
          );
          await service.store.saveChannel(
            {
              id: endpoint.id,
              provider: "wecom",
              ownerId: endpoint.ownerId,
              name: endpoint.id,
              groupScope: endpoint.groupScope,
              botId: endpoint.botId,
            },
            true,
            null,
          );
          for (const [sender, actor] of Object.entries(endpoint.senders))
            await service.store.linkSender(endpoint.id, sender, actor);
        }
      }
      service.im.setDelivery((channel, address, text) => {
        const adapter = service.adapters.get(channel)?.adapter;
        if (!adapter) throw Error("connection_unavailable");
        return adapter.deliver(address, text);
      });
      await service.im.recover([]);
      for (const c of service.store.channels())
        if (c.enabled)
          try {
            await service.connect(c);
          } catch {
            /* Configuration survives platform outages. */
          }
      return service;
    } catch (error) {
      // The failing ChannelSync owns its own cleanup; release every unstarted port too.
      await Promise.allSettled(transports.slice(attempted).map(transport => Promise.resolve().then(() => transport.close?.())));
      await service?.close().catch(() => {});
      throw error;
    }
  }
  /** `store` is the switchboard this service owns and closes. */
  constructor(dependencies, store) {
    this.dependencies = dependencies;
    this.store = store;
    this.credentials =
      dependencies.credentials ??
      new ModelCredentialRepository(fileSecretStore(join(dependencies.dataDirectory, "models")));
    this.execution = createImExecution(dependencies);
    this.im = new ImPlugin(this.store, this.execution, 1024, !!dependencies.capabilities);
    this.wecomHistory = new ImWeComHistory(this.im, this.store, this.credentials, dependencies.wecomHistoryFetch);
    try {
      this.wecomPosts = new ImWeComPosts(this.wecomHistory, new ImPostReceipts(join(dependencies.dataDirectory, "im-posts.sqlite")));
    } catch (error) {
      this.wecomHistory.close();
      this.store.close();
      throw error;
    }
    this.unregisterCapabilities = dependencies.capabilities?.register({
      id: 'im.reply',
      tools: session => {
        const ref = { serverId: session.serverId, threadId: session.threadId };
        return [
          ...(this.im.replyAvailable(ref) ? [IM_REPLY_TOOL] : []),
          ...(this.im.readAvailable(ref) ? IM_READ_TOOLS : []),
          ...(this.wecomHistory.available(ref) ? [...WECOM_HISTORY_TOOLS, WECOM_POST_TOOL] : []),
        ];
      },
      call: (session, name, args, signal) => {
        const ref = { serverId: session.serverId, threadId: session.threadId };
        if (name === WECOM_POST_TOOL.name) return this.wecomPosts.call(ref, args, signal);
        if (WECOM_HISTORY_TOOLS.some(tool => tool.name === name)) return this.wecomHistory.call(ref, name, args, signal);
        if (IM_READ_TOOLS.some(tool => tool.name === name)) return this.im.read(ref, name, args, signal);
        if (name !== 'im_reply') throw Error('capability_denied');
        return this.im.reply(ref, args, signal);
      },
    });
    this.channelSyncs = [];
    this.channelCallbacks = new Map();
    this.adapters = new Map();
    this.serial = Promise.resolve();
    this.closed = false;
  }
  // Compatibility for installation-level actions; never select an arbitrary connection.
  get channelSync() { return this.channelSyncs.length === 1 ? this.channelSyncs[0] : undefined; }
  get postOutcome() { return this.wecomPosts.receipts.outcome; }
  get outcome() {
    return this.store.outcome;
  }
  states() {
    return this.store.channels().map((c) => ({
      id: c.id,
      provider: c.provider,
      state: !c.enabled
        ? "disabled"
        : (this.adapters.get(c.id)?.adapter.state ?? "disconnected"),
      ...(c.provider === "wecom" && this.adapters.get(c.id)?.adapter.diagnostics
        ? { diagnostics: this.adapters.get(c.id).adapter.diagnostics } : {}),
    }));
  }
  async connect(c) {
    this.disconnect(c.id);
    if (!c.enabled || this.closed) return;
    const unregister = this.im.register({
      ...c,
      senders: {},
      platform: c.provider,
    });
    const notificationSenders = new Map(Object.entries(this.store.senderLinks(c.id)));
    const receive = async (message) => {
      if (!this.store.channel(c.id)?.enabled) throw Error("channel_disabled");
      // Identity verification is a control message, never agent input or user routing code.
      if (/^\/identify(?:\s|$)/u.test(message.text.trim())) {
        if (message.source.chatType !== "direct")
          throw Error("private_identity_required");
        const code = message.text.trim().slice("/identify".length).trim();
        if (!/^[a-f0-9]{32}$/u.test(code))
          throw Error("invalid_identity_challenge");
        const actor = await this.store.consumeChallenge(
          digest(code),
          c.id,
          message.source.senderId,
          (actor) => this.execution.human(actor),
        );
        if (!actor) throw Error("invalid_identity_challenge");
        this.execution.human(actor);
        notificationSenders.set(message.source.senderId,actor);
        await message.reply(
          "身份已关联。后续消息将以你的 OpenCraft 账号权限处理。",
        );
        return;
      }
      return this.im.receive(c.id, message);
    };
    const onState = (state) => {
      if (state === "ready" && !this.closed) void this.im.resume(c.id).catch(() => {});
    };
    try {
      let adapter;
      if (c.provider === "wecom") {
        const value = await this.credentials.resolve(
          credential(c.id, "secret"),
        );
        if (!value) throw Error("credentials_missing");
        adapter =
          this.dependencies.createWeCom?.({
            botId: c.botId,
            secret: value,
            receive,
            onState,
          }) ??
          new WeComPlugin({ botId: c.botId, secret: value, receive, onState });
      } else {
        const botToken = await this.credentials.resolve(
            credential(c.id, "botToken"),
          ),
          appToken = await this.credentials.resolve(
            credential(c.id, "appToken"),
          );
        if (!botToken || !appToken) throw Error("credentials_missing");
        const auth = await (this.dependencies.slackApi ?? slackApi)(
          botToken,
          "auth.test",
          {},
        );
        if (
          typeof auth.team_id !== "string" ||
          typeof auth.user_id !== "string" ||
          (c.workspaceId && c.workspaceId !== auth.team_id) ||
          (c.botUserId && c.botUserId !== auth.user_id)
        )
          throw Error("slack_installation_mismatch");
        if (!c.workspaceId || !c.botUserId) {
          c = { ...c, workspaceId: auth.team_id, botUserId: auth.user_id };
          await this.store.saveChannel(c, c.enabled, c.revision);
        }
        adapter =
          this.dependencies.createSlack?.({
            botToken,
            appToken,
            workspaceId: auth.team_id,
            botUserId: auth.user_id,
            receive,
            onState,
          }) ??
          new SlackPlugin({
            botToken,
            appToken,
            workspaceId: auth.team_id,
            botUserId: auth.user_id,
            receive,
            onState,
          });
      }
      if (this.closed) {
        unregister();
        adapter.close();
        return;
      }
      this.adapters.set(c.id, { adapter, unregister, notificationSenders, name:c.name });
      adapter.start();
    } catch (error) {
      unregister();
      throw error;
    }
  }
  disconnect(id) {
    const entry = this.adapters.get(id);
    if (entry) {
      entry.unregister();
      entry.adapter.close();
      this.adapters.delete(id);
    }
  }
  publicChannel(c, actorId) {
    return {
      ...c,
      ...(c.ownerId === actorId ? {} : { route: null, draft: null }),
      canManage: c.ownerId === actorId,
      state: !c.enabled
        ? "disabled"
        : (this.adapters.get(c.id)?.adapter.state ?? "disconnected"),
      senders: Object.entries(this.store.senderLinks(c.id))
        .filter(([, actor]) => actor === actorId || c.ownerId === actorId)
        .map(([senderId, actorId]) => ({ senderId, actorId })),
      versions: c.ownerId === actorId ? this.store.versions(c.id) : [],
    };
  }
  async operation(context, body) {
    if (this.closed) throw Error("service_closed");
    fields(body, [
      "action",
      "id",
      "revision",
      "config",
      "credentials",
      "source",
      "publish",
      "event",
      "messageId",
      "reference",
      "hostId",
      "threadId",
      "senderId",
      "search",
      "cursor",
    ]);
    const actor = this.execution.human(context.actorId);
    // The single configured channel transport may issue a per-person link proof
    // (for example to associate a provider account). Never chosen by the client.
    if (body.action === "channel.link") {
      if (Object.keys(body).some(key => key !== "action") || !this.channelSync?.transport.link) throw Error("invalid_operation");
      return this.channelSync.transport.link(context);
    }
    if (body.action === "list")
      return {
        channels: this.store
          .channels()
          .filter(
            (c) =>
              c.ownerId === actor.actorId ||
              Object.values(this.store.senderLinks(c.id)).includes(
                actor.actorId,
              ),
          )
          .map((c) => this.publicChannel(c, actor.actorId)),
        actorId: actor.actorId,
        serverId: this.dependencies.collaboration.execution.serverId,
        servers: this.dependencies.collaboration.execution.servers ?? [],
        workbenchHostId:
          this.dependencies.workbenchHostId ??
          this.dependencies.collaboration.execution.hostId,
      };
    if (body.action === "sources") {
      const { conversationRef, encodeConversationRef } = await import(
        "@opencraft/appserver-protocol/collaboration"
      );
      const execution = this.dependencies.collaboration.execution;
      let serverId;
      try { serverId = execution.serverForHost?.(body.hostId, id(body.threadId))
        ?? (body.hostId === (this.dependencies.workbenchHostId ?? execution.hostId) ? execution.serverId : null); }
      catch { throw Error("unsupported_host"); }
      if (!serverId) throw Error("unsupported_host");
      const ref = conversationRef({
        serverId,
        threadId: id(body.threadId),
      });
      await this.execution.validate(actor, ref, AbortSignal.timeout(10_000));
      const sources = new Map();
      for (const c of this.store.channels()) {
        if (
          c.ownerId !== actor.actorId &&
          !Object.values(this.store.senderLinks(c.id)).includes(actor.actorId)
        )
          continue;
        for (const m of await this.store.messages(c.id, 500)) {
          if (c.ownerId !== actor.actorId && m.actor_id !== actor.actorId)
            continue;
          if (!m.conversation_ref) continue;
          const target = JSON.parse(m.conversation_ref);
          if (
            target.serverId !== ref.serverId ||
            target.threadId !== ref.threadId
          )
            continue;
          const source = JSON.parse(m.source),
            key = JSON.stringify([
              c.id,
              source.chatId,
              source.threadId ?? null,
              source.senderId,
            ]);
          if (!sources.has(key))
            sources.set(key, {
              channelId: c.id,
              name: c.name,
              provider: c.provider,
              source,
              revision: m.route_revision,
              lastSeen: m.created_at,
            });
        }
      }
      return {
        sources: [...sources.values()],
        reference: encodeConversationRef(ref),
      };
    }
    if (body.action === "create") {
      fields(body.config, ["name", "provider", "botId"]);
      fields(
        body.credentials,
        body.config.provider === "wecom"
          ? ["secret"]
          : ["botToken", "appToken"],
      );
      const provider = body.config.provider;
      if (!["wecom", "slack"].includes(provider))
        throw Error("invalid_platform");
      const c = {
        id: randomUUID(),
        provider,
        ownerId: actor.actorId,
        name: id(body.config.name),
        groupScope: "sender",
        ...(provider === "wecom" ? { botId: id(body.config.botId) } : {}),
      };
      if (
        provider === "wecom" &&
        this.store
          .channels()
          .some((x) => x.provider === "wecom" && x.botId === c.botId)
      )
        throw Error("bot_already_configured");
      const keys = provider === "wecom" ? ["secret"] : ["botToken", "appToken"];
      for (const key of keys) secret(body.credentials[key]);
      for (const key of keys)
        await this.credentials.set(
          credential(c.id, key),
          body.credentials[key],
        );
      this.execution.authorize(actor);
      await this.store.saveChannel(c, true, null);
      // Existing installations preserve legacy tuples; newly created channels explicitly select the new default.
      await this.store.route(c.id, 1, sourceRoute, true);
      try {
        await this.connect(this.store.channel(c.id));
      } catch {
        return {
          channel: this.publicChannel(this.store.channel(c.id), actor.actorId),
          connectionError: true,
        };
      }
      return {
        channel: this.publicChannel(this.store.channel(c.id), actor.actorId),
      };
    }
    const c = this.store.channel(id(body.id));
    if (!c) throw Error("channel_missing");
    const manages = c.ownerId === actor.actorId;
    const uses =
      manages ||
      Object.values(this.store.senderLinks(c.id)).includes(actor.actorId);
    if (body.action === "identity") {
      // Possession of a channel identifier grants no conversation access. The challenge binds this human only.
      const code = randomBytes(16).toString("hex");
      await this.store.challenge(digest(code), c.id, actor.actorId);
      return { command: "/identify " + code, expiresAt: Date.now() + 300_000 };
    }
    if (!uses) throw Error("channel_denied");
    if (body.action === "unlink") {
      const sender = id(body.senderId);
      if (!manages && this.store.senderLinks(c.id)[sender] !== actor.actorId)
        throw Error("channel_denied");
      await this.store.unlinkSender(c.id, sender);
      this.adapters.get(c.id)?.notificationSenders?.delete(sender);
      return { ok: true };
    }
    if (body.action === "messages")
      return {
        messages: (await this.store.messages(c.id))
          .filter((m) => manages || m.actor_id === actor.actorId)
          .map(({ reply_address, fingerprint, text, reply_text, ...m }) => m),
      };
    if (!manages) throw Error("channel_denied");
    if (body.action === "conversations") {
      const { encodeConversationRef } = await import(
        "@opencraft/appserver-protocol/collaboration"
      );
      if (
        body.search !== undefined &&
        (typeof body.search !== "string" || body.search.length > 256)
      )
        throw Error("invalid_input");
      if (
        body.cursor !== undefined &&
        body.cursor !== null &&
        (typeof body.cursor !== "string" || body.cursor.length > 2048)
      )
        throw Error("invalid_input");
      const result = await this.dependencies.collaboration.discover(
        actor,
        body.search ?? "",
        body.cursor ?? null,
      );
      this.execution.authorize(actor);
      return {
        conversations: result.conversations.map((c) => ({
          reference: encodeConversationRef(c.ref),
          title: c.title,
          engine: this.dependencies.collaboration.execution.servers?.find(server=>server.serverId===c.ref.serverId)?.label,
        })),
        nextCursor: result.nextCursor,
      };
    }
    if (body.action === "preview") {
      const e = object(body.event);
      fields(e, ["id", "channelId", "platform", "chat", "sender", "text"]);
      if (
        e.channelId !== c.id ||
        e.platform !== c.provider ||
        typeof e.text !== "string" ||
        e.text.length > 16_384
      )
        throw Error("invalid_preview");
      id(e.id);
      fields(e.chat, ["id", "type", "threadId"]);
      fields(e.sender, ["id", "actorId"]);
      id(e.chat.id);
      id(e.sender.id);
      if (!["direct", "group"].includes(e.chat.type))
        throw Error("invalid_preview");
      if (e.chat.threadId !== undefined) id(e.chat.threadId);
      // Preview cannot impersonate another human or enumerate their conversations.
      e.sender = { id: e.sender.id, actorId: actor.actorId };
      const decision = await evaluateRoute(routeSource(body.source), e);
      this.execution.authorize(actor);
      return { decision, sideEffects: false };
    }
    if (body.action === "route") {
      if (body.source !== null) await compileRoute(routeSource(body.source));
      this.execution.authorize(actor);
      const next = await this.store.route(
        c.id,
        body.revision,
        body.source,
        body.publish === true,
      );
      return { channel: this.publicChannel(next, actor.actorId) };
    }
    if (body.action === "update") {
      fields(body.config, ["name", "enabled"]);
      if (typeof body.config.enabled !== "boolean")
        throw Error("invalid_input");
      if (c.revision !== body.revision) throw Error("revision_conflict");
      fields(
        body.credentials ?? {},
        c.provider === "wecom" ? ["secret"] : ["botToken", "appToken"],
      );
      for (const [key, value] of Object.entries(body.credentials ?? {}))
        if (value)
          await this.credentials.set(credential(c.id, key), secret(value));
      this.execution.authorize(actor);
      const next = await this.store.saveChannel(
        { ...c, name: id(body.config.name) },
        body.config.enabled,
        c.revision,
      );
      if (!next.enabled) this.disconnect(c.id);
      else
        try {
          await this.connect(next);
        } catch {
          return {
            channel: this.publicChannel(
              this.store.channel(c.id),
              actor.actorId,
            ),
            connectionError: true,
          };
        }
      return {
        channel: this.publicChannel(this.store.channel(c.id), actor.actorId),
      };
    }
    if (body.action === "reconnect") {
      try {
        await this.connect(c);
        return { ok: true };
      } catch {
        throw Error("connection_failed");
      }
    }
    if (body.action === "delete") {
      this.disconnect(c.id);
      await this.store.removeChannel(c.id);
      for (const key of ["secret", "botToken", "appToken"])
        await this.credentials.remove(credential(c.id, key));
      return { ok: true };
    }
    if (body.action === "resume") {
      await this.im.resume(c.id);
      return { ok: true };
    }
    if (body.action === "resend") {
      const m = await this.store.message(id(body.messageId));
      if (m?.channel_id !== c.id) throw Error("invalid_delivery");
      await this.im.resend(m.id);
      return { ok: true };
    }
    throw Error("invalid_operation");
  }
  notificationEntries(actorId) {
    const actor=this.dependencies.actors.get(actorId);
    if(this.closed || !actor?.enabled || actor.kind!=='human' || this.dependencies.admittedActor?.(actorId)===false)return [];
    const entries=[...this.adapters.entries()].filter(([,entry])=>typeof entry.adapter?.sendDirect==='function')
      .flatMap(([channelId,entry])=>[...entry.notificationSenders.entries()].filter(([,owner])=>owner===actorId)
        .map(([senderId])=>({target:{channelId,senderId,label:entry.name+' · '+senderId},adapter:entry.adapter})));
    for (const sync of this.channelSyncs ?? []) {
      const contribution=sync.transport.notifications;
      try {
        for (const target of contribution?.targets(actorId) ?? []) entries.push({target,sync,contribution});
      } catch { /* An unavailable provider cannot contribute a verified target. */ }
    }
    // The existing notification contract addresses a (channelId,senderId) pair.
    // Ambiguous provider claims must fail closed, never select by installation order.
    const counts=new Map();
    const key=target=>JSON.stringify([target.channelId,target.senderId]);
    for(const {target} of entries)counts.set(key(target),(counts.get(key(target))??0)+1);
    return entries.filter(({target})=>counts.get(key(target))===1);
  }
  notificationTargets(actorId) {
    return this.notificationEntries(actorId).map(entry=>entry.target);
  }
  prepareDirectNotification(channelId,senderId,actorId) {
    const find=()=>this.notificationEntries(actorId).find(({target})=>target.channelId===channelId && target.senderId===senderId);
    const selected=find();
    if(!selected)throw Error('notification_binding_denied');
    const assertCurrent=()=>{
      const current=find();
      if(!current || current.sync!==selected.sync || current.contribution!==selected.contribution || current.adapter!==selected.adapter)throw Error('notification_binding_denied');
    };
    return async (content,requestId)=>{
      assertCurrent();
      if(selected.contribution) {
        if(!selected.contribution.send)throw Error('notification_binding_denied');
        return selected.contribution.send(actorId,{channelId,senderId},content,requestId,assertCurrent);
      }
      const adapter=selected.adapter;
      if(!adapter?.sendDirect || adapter.state!=='ready')throw Object.assign(Error('notification_unavailable'),{deliveryState:'not_sent'});
      return adapter.sendDirect(senderId,content,requestId,assertCurrent);
    };
  }
  prepareOperatorNotification(channelId, senderId, actorId) {
    const channel = this.store.channels().find(row => row.id === channelId && row.provider === 'wecom' && row.enabled);
    if (!channel || this.store.senderLinks(channelId)[senderId] !== actorId) throw Error('notification_binding_denied');
    const actor = this.dependencies.actors.get(actorId);
    if (!actor?.enabled || actor.kind !== 'human' || this.dependencies.admittedActor?.(actorId) === false) throw Error('notification_actor_denied');
    const adapter = this.adapters.get(channelId)?.adapter;
    if (!adapter?.sendDirect || adapter.state !== 'ready') throw Error('notification_unavailable');
    return (content,requestId) => adapter.sendDirect(senderId, content, requestId);
  }
  async handle(request, response, sameOrigin) {
    const path = new URL(request.url ?? "/", "http://im.invalid").pathname;
    if (!path.startsWith("/__opencraft_im")) return false;
    const send = (status, value) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(value));
    };
    const context = this.dependencies.actorAccess.authenticate(request);
    const actor = context && !context.credentialId ? this.dependencies.actors.get(context.actorId) : null;
    const human = actor?.kind === "human";
    if (path === "/__opencraft_im/capabilities" && request.method === "GET") {
      const nativeChannels = human && this.dependencies.collaboration?.available
        && this.dependencies.actors.isCurrent(context) && (this.dependencies.admittedActor?.(context.actorId) ?? true);
      const options=nativeChannels?groupCreateOptions():[];
      send(200, {available:!!human,...(nativeChannels?{nativeChannels:true,channelGroupTools:true,channels:1,channelImages:true,
        ...(options.length?{groupCreateOptions:options}:{})}:{})});
      return true;
    }
    if (!human) {
      send(401, { error: "human_authentication_required" });
      return true;
    }
    const imageRoute = /^\/__opencraft_im\/channel-image\/([^/]+)\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if(imageRoute){try{imageRoute[1]=decodeURIComponent(imageRoute[1]);}catch{send(400,{error:'invalid_input'});return true;}}
    const imageRead = imageRoute && request.method === "GET";
    if (!imageRead && (request.method !== "POST" || (!imageRoute && path !== "/__opencraft_im"))) {
      send(404, { error: "missing" });
      return true;
    }
    // Match ActorAccess and collaboration writes: TLS may terminate before
    // this listener. Host is preserved by the trusted proxy; forwarded headers
    // never confer origin authority.
    const origin = request.headers.origin;
    const trustedOrigin = this.dependencies.actorAccess.options?.trustedOrigin?.(request);
    const humanOrigin = typeof origin === "string" &&
      (origin === trustedOrigin ||
        ["http:", "https:"].some(protocol => origin === protocol + "//" + request.headers.host));
    const contentType = request.headers["content-type"]?.split(";")[0];
    const acceptedBody = imageRoute ? CHANNEL_IMAGE_TYPES.includes(contentType) : contentType === "application/json";
    if (imageRead ? request.headers["sec-fetch-site"] === "cross-site" : !acceptedBody || !(humanOrigin || sameOrigin(request, true))) {
      send(403, { error: "same_origin_required" });
      return true;
    }
    const assertAuthorized = () => {
      const current = this.dependencies.actorAccess.authenticate(request);
      if (this.closed || !this.dependencies.collaboration?.available || !current || current.credentialId
        || current.actorId !== context.actorId || current.generation !== context.generation
        || !this.dependencies.actors.isCurrent(current)
        || !(this.dependencies.admittedActor?.(current.actorId) ?? true)) throw Error('channel_denied');
    };
    try {
      if (imageRoute) {
        assertAuthorized();
        if (imageRead) {
          const sequence = Number(imageRoute[2]);
          if (!/^[1-9]\d*$/.test(imageRoute[2]) || !Number.isSafeInteger(sequence)) throw Error('invalid_input');
          const image = await this.dependencies.collaboration.communicate(context,'channel/image',{channelId:imageRoute[1],sequence});
          await this.dependencies.collaboration.communicate(context,'channel/readable',{channelId:imageRoute[1]});
          assertAuthorized();
          if (!image) { send(404, { error: "missing" }); return true; }
          response.writeHead(200, { "content-type": image.type, "content-length": image.bytes.length,
            "cache-control": "private, no-store", "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin" });
          response.end(Buffer.from(image.bytes));
          return true;
        }
      }
      let size = 0;
      const limit = imageRoute ? CHANNEL_IMAGE_LIMIT : 65536;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > limit) {
          send(413, { error: "too_large" });
          return true;
        }
        chunks.push(chunk);
      }
      if (imageRoute) {
        const {receipt} = await this.dependencies.collaboration.communicate(context,'channel/image/send',
          {channelId:imageRoute[1],clientMessageId:imageRoute[2],type:contentType,bytes:Buffer.concat(chunks,size)});
        assertAuthorized();
        send(200, { receipt });
        return true;
      }
      if (!this.dependencies.actorAccess.authenticate(request))
        throw Error("channel_denied");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const job = this.serial
        .catch(() => {})
        .then(() => {
          if (!this.dependencies.actorAccess.authenticate(request))
            throw Error("channel_denied");
          return this.operation(context, body);
        });
      this.serial = job;
      const result = await job;
      if (!this.dependencies.actorAccess.authenticate(request))
        throw Error("channel_denied");
      send(200, result);
    } catch (error) {
      const allowed = new Set([
        "revision_conflict",
        "channel_denied",
        "channel_missing",
        "invalid_route",
        "invalid_route_result",
        "invalid_preview",
        "invalid_credentials",
        "bot_already_configured",
        "connection_failed",
        "identity_conflict",
        "invalid_delivery",
        "invalid_platform",
        "invalid_operation",
        "unsupported_host",
        "invalid_input",
      ]);
      const code = allowed.has(error?.message)
        ? error.message
        : "operation_failed";
      send(
        code === "revision_conflict"
          ? 409
          : code === "channel_denied"
            ? 403
            : 400,
        { error: code },
      );
    }
    return true;
  }
  async handleChannelCallback(request, response, pathname) {
    if (this.closed || request.method !== 'POST') return false;
    const callback = this.channelCallbacks.get(pathname);
    if (!callback) return false;
    await callback(request, response);
    return true;
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.channelCallbacks.clear();
    this.closing = this.closeConnections();
    return this.closing;
  }
  async closeConnections() {
    const failures=[];
    const cleanup=async action=>{try { await action(); } catch(error) { failures.push(error); }};
    await cleanup(()=>this.unregisterCapabilities?.());
    const connections=this.channelSyncs.splice(0);
    for(const result of await Promise.allSettled(connections.map(sync=>sync.close())))
      if(result.status==='rejected')failures.push(result.reason);
    await this.serial.catch(() => {});
    for (const id of this.adapters.keys()) await cleanup(()=>this.disconnect(id));
    await cleanup(()=>this.wecomPosts.close());
    await cleanup(()=>this.wecomHistory.close());
    await cleanup(()=>this.im.close());
    if(failures.length)throw new AggregateError(failures,'IM connection shutdown failed');
  }
}
