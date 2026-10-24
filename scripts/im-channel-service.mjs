import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { SwitchboardStore } from "../plugins/im/src/store.ts";
import { IM_REPLY_TOOL } from "../plugins/im/src/reply-tool.ts";
import { ImPlugin } from "../plugins/im/src/server.ts";
import {
  compileRoute,
  evaluateRoute,
  routeSource,
  sourceRoute,
} from "../plugins/im/src/routing.ts";
import { WeComPlugin } from "../plugins/wecom/src/server.ts";
import { SlackPlugin, slackApi } from "../plugins/slack/src/server.ts";
import { ModelCredentialRepository } from "../apps/local-agent-host/src/model-config/repository.ts";
import { createImExecution } from "./im-plugins.mjs";

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

/** Composition owns credentials and platform transports. IM sees only verified humans and delivery ports. */
export class ImChannelService {
  static async open(endpoints, dependencies) {
    const service = new ImChannelService(dependencies);
    try {
      for (const endpoint of endpoints) {
        if (!service.store.hasChannel(endpoint.id)) {
          await service.credentials.set(
            credential(endpoint.id, "secret"),
            endpoint.secret,
          );
          service.store.saveChannel(
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
            service.store.linkSender(endpoint.id, sender, actor);
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
      await service.close();
      throw error;
    }
  }
  constructor(dependencies) {
    this.dependencies = dependencies;
    this.store = new SwitchboardStore(
      join(dependencies.dataDirectory, "im-switchboard.sqlite"),
    );
    this.credentials =
      dependencies.credentials ??
      new ModelCredentialRepository(join(dependencies.dataDirectory, "models"));
    this.execution = createImExecution(dependencies);
    this.im = new ImPlugin(this.store, this.execution, 1024, !!dependencies.capabilities);
    this.unregisterCapabilities = dependencies.capabilities?.register({
      id: 'im.reply',
      tools: session => this.im.replyAvailable(session) ? [IM_REPLY_TOOL] : [],
      call: (session, name, args, signal) => {
        if (name !== 'im_reply') throw Error('capability_denied');
        return this.im.reply(session, args, signal);
      },
    });
    this.adapters = new Map();
    this.serial = Promise.resolve();
    this.closed = false;
  }
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
    const receive = async (message) => {
      if (!this.store.channel(c.id)?.enabled) throw Error("channel_disabled");
      // Identity verification is a control message, never agent input or user routing code.
      if (/^\/identify(?:\s|$)/u.test(message.text.trim())) {
        if (message.source.chatType !== "direct")
          throw Error("private_identity_required");
        const code = message.text.trim().slice("/identify".length).trim();
        if (!/^[a-f0-9]{32}$/u.test(code))
          throw Error("invalid_identity_challenge");
        const actor = this.store.consumeChallenge(
          digest(code),
          c.id,
          message.source.senderId,
          (actor) => this.execution.human(actor),
        );
        if (!actor) throw Error("invalid_identity_challenge");
        this.execution.human(actor);
        await message.reply(
          "身份已关联。后续消息将以你的 OpenCraft 账号权限处理。",
        );
        return;
      }
      return this.im.receive(c.id, message);
    };
    const onState = (state) => {
      if (state === "ready" && !this.closed) this.im.resume(c.id);
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
          this.store.saveChannel(c, c.enabled, c.revision);
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
      this.adapters.set(c.id, { adapter, unregister });
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
        "../packages/appserver-protocol/src/collaboration.ts"
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
        for (const m of this.store.messages(c.id, 500)) {
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
      this.store.saveChannel(c, true, null);
      // Existing installations preserve legacy tuples; newly created channels explicitly select the new default.
      this.store.route(c.id, 1, sourceRoute, true);
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
      this.store.challenge(digest(code), c.id, actor.actorId);
      return { command: "/identify " + code, expiresAt: Date.now() + 300_000 };
    }
    if (!uses) throw Error("channel_denied");
    if (body.action === "unlink") {
      const sender = id(body.senderId);
      if (!manages && this.store.senderLinks(c.id)[sender] !== actor.actorId)
        throw Error("channel_denied");
      this.store.unlinkSender(c.id, sender);
      return { ok: true };
    }
    if (body.action === "messages")
      return {
        messages: this.store
          .messages(c.id)
          .filter((m) => manages || m.actor_id === actor.actorId)
          .map(({ reply_address, fingerprint, text, reply_text, ...m }) => m),
      };
    if (!manages) throw Error("channel_denied");
    if (body.action === "conversations") {
      const { encodeConversationRef } = await import(
        "../packages/appserver-protocol/src/collaboration.ts"
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
      const next = this.store.route(
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
      const next = this.store.saveChannel(
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
      this.store.removeChannel(c.id);
      for (const key of ["secret", "botToken", "appToken"])
        await this.credentials.remove(credential(c.id, key));
      return { ok: true };
    }
    if (body.action === "resume") {
      this.im.resume(c.id);
      return { ok: true };
    }
    if (body.action === "resend") {
      const m = this.store.message(id(body.messageId));
      if (m?.channel_id !== c.id) throw Error("invalid_delivery");
      await this.im.resend(m.id);
      return { ok: true };
    }
    throw Error("invalid_operation");
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
    const human =
      context &&
      !context.credentialId &&
      this.dependencies.actors.get(context.actorId)?.kind === "human";
    if (path === "/__opencraft_im/capabilities" && request.method === "GET") {
      send(200, { available: !!human });
      return true;
    }
    if (!human) {
      send(401, { error: "human_authentication_required" });
      return true;
    }
    if (path !== "/__opencraft_im" || request.method !== "POST") {
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
    if (
      request.headers["content-type"]?.split(";")[0] !== "application/json" ||
      !(humanOrigin || sameOrigin(request, true))
    ) {
      send(403, { error: "same_origin_required" });
      return true;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) {
          send(413, { error: "too_large" });
          return true;
        }
        chunks.push(chunk);
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
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unregisterCapabilities?.();
    await this.serial.catch(() => {});
    for (const id of this.adapters.keys()) this.disconnect(id);
    await this.im.close();
  }
}
