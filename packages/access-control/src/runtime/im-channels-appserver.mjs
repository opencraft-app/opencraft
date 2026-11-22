import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { CHANNELS_CHANGED, CHANNELS_EXTENSION, PERSONAL_ASSISTANT_EXTENSION, isJsonRpcRequest, parseJsonRpcMessage } from '@opencraft/appserver-protocol';
import { ClientObserverList, TransportStatusObservers } from '@opencraft/appserver-client/transport';
import { nativeChannelId } from '../native-channels.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('invalid_input');
  return value;
}
function fault(error) {
  if (error?.code === 'idempotency_conflict' || error?.code === 'idempotency_key_reused') return { code: -32009, message: 'idempotency_conflict' };
  if (['channel_dissolved','channel_owner_cannot_leave','channel_revision_conflict'].includes(error?.message)) return {code:-32009,message:error.message};
  if (error?.message === 'channel_denied' || error?.status === 401 || error?.status === 403) return { code: -32003, message: 'channel_denied' };
  if (error?.message === 'invalid_input' || error?.status === 400) return { code: -32602, message: 'invalid_input' };
  if (error?.code === 'session_not_bound' || error?.code === 'channel_wake_unavailable') return { code: -32009, message: error.code };
  if (error?.message === 'channel_files_unavailable') return { code: -32010, message: 'channel_files_unavailable' };
  if (error?.message === 'method_not_found') return { code: -32601, message: 'method_not_found' };
  return { code: -32603, message: 'channel_operation_failed' };
}

/** A logical App Host service on the existing socket, with no engine dependency. */
export class ImChannelsAppServer {
  status = { state: 'idle' };
  #frames = new ClientObserverList();
  #statuses = new TransportStatusObservers();
  #clients = new Map();
  #unwatch = [];
  #membershipRefresh;

  constructor(getNative) { this.getNative = getNative; }

  async connect(signal) {
    signal?.throwIfAborted();
    if (!this.getNative()?.available) throw Error('Channels unavailable');
    this.status = { state: 'open' };
    this.#statuses.emit(this.status, () => this.status.state === 'open');
  }

  subscribeMessage(listener) { return this.#frames.subscribe(listener); }
  subscribeStatus(listener) { return this.#statuses.subscribe(listener, this.status); }

  async close() {
    for (const unwatch of this.#unwatch.splice(0)) unwatch();
    clearInterval(this.#membershipRefresh);
    this.#membershipRefresh = undefined;
    this.#clients.clear();
    this.status = { state: 'closed' };
    this.#statuses.emit(this.status, () => this.status.state === 'closed');
    this.#frames.clear();
    this.#statuses.clear();
  }

  async send(frame, signal) { return this.sendWithContext(frame, null, signal); }

  async sendWithContext(frame, context, signal) {
    signal?.throwIfAborted();
    const raw = JSON.parse(frame);
    const key = raw[LOGICAL_CLIENT_FIELD];
    if (typeof key !== 'string') throw Error('Channels require a logical client');
    const request = parseJsonRpcMessage(frame);
    if ('method' in request && request.method === 'runtime/client/disconnect' && !('id' in request)) {
      this.#clients.delete(key);
      return;
    }
    if (!isJsonRpcRequest(request)) return;
    // Accept the frame independently of provider I/O so history and retries can
    // still proceed while an earlier send is awaiting a provider response.
    void this.#respond(key, request, context, signal);
  }

  #emit(key, payload) {
    if (this.status.state === 'open') {
      this.#frames.emit(JSON.stringify({ jsonrpc: '2.0', [LOGICAL_CLIENT_FIELD]: key, ...payload }));
    }
  }

  async #respond(key, request, context, signal) {
    let client = this.#clients.get(key);
    const authorize = () => {
      if (signal?.aborted || this.status.state !== 'open' || this.#clients.get(key) !== client) throw Error('channel_denied');
      return this.#access(context);
    };
    try {
      if (request.method === 'initialize') {
        const access = authorize();
        client ??= { context, subscriptions: new Map() };
        this.#clients.set(key, client);
        this.#emit(key, { id: request.id, result: {
          codexHome: '', platformFamily: process.platform, platformOs: process.platform, userAgent: 'OpenCraft Channels',
          capabilities: { extensions: { ...(access.native ? {[PERSONAL_ASSISTANT_EXTENSION]:{version:1,readOnlyDelegation:true}}:{}), [CHANNELS_EXTENSION]: { version: 1, ...(access.native ? { native: true, inbox: 1, read: true, groupLifecycle: 1, attachments: 1, attachmentChunks: 1, authority: access.native.actors.authority, actorId: access.actorContext.actorId } : {}) } } },
        } });
        return;
      }
      if (!client) throw Error('channel_denied');
      const result = await this.#command(authorize(), client, request, authorize);
      const current=authorize();
      if(typeof request.params?.channelId==='string' && request.method.startsWith('opencraft/channels/') && !['opencraft/channels/unsubscribe','opencraft/channels/group/leave'].includes(request.method))
        await this.#readable(current,request.params.channelId);
      if(request.method==='opencraft/channels/search') {
        // Recheck the returned scopes after the asynchronous Worker boundary.
        for(const channelId of new Set(result.matches.map(match=>match.channel.id)))
          await this.#readable(authorize(),channelId);
      }
      authorize();
      this.#emit(key, { id: request.id, result });
    } catch (error) {
      if (!signal?.aborted) this.#emit(key, { id: request.id, error: fault(error) });
    }
  }

  #access(context) {
    const actorContext = context?.actorContext, native = this.getNative();
    try { context.resourceOwner.assertCurrent(); } catch { throw Error('channel_denied'); }
    const nativeAccess = native?.available && actorContext && native.actors.isCurrent(actorContext)
      && native.admittedActor(actorContext.actorId) ? native : null;
    if (!nativeAccess) throw Error('channel_denied');
    return {native:nativeAccess,actorContext};
  }
  #readable(access,channelId){
    if(!nativeChannelId(channelId))throw Error('channel_denied');
    return access.native.communicate(access.actorContext,'channel/readable',{channelId});
  }

  async #command(access, client, request, authorize) {
    const { native, actorContext } = access;
    const params = request.params ?? {};
    // Native communication has one asynchronous Worker-backed authority. The
    // adapter never owns storage or selects a separate provider timeline.
    if (request.method === 'opencraft/inbox/sync') {
      fields(params,['cursor','limit']);
      if (!native) throw Error('channel_denied');
      return native.communicate(actorContext,'inbox/sync',params);
    }
    if (request.method.startsWith('opencraft/personal-assistant/'))
      return native.personalAssistant(actorContext,request.method,params);
    // Crew phonebooks are grants over Actors, decided by the same native communication authority.
    if (request.method.startsWith('opencraft/crew/')) {
      if (!native) throw Error('channel_denied');
      if (request.method === 'opencraft/crew/desk') return native.crewDesk(actorContext,params);
      if (request.method === 'opencraft/crew/team') return native.crewTeam(actorContext,params);
      return native.communicate(actorContext,request.method,params);
    }
    const nativeCommand = request.method.startsWith('opencraft/channels/')
      && !['opencraft/channels/subscribe','opencraft/channels/unsubscribe'].includes(request.method)
      && (params.channelId === undefined || nativeChannelId(params.channelId));
    if (nativeCommand) {
      if (!native) throw Error('channel_denied');
      return native.communicate(actorContext,request.method,params);
    }
    switch (request.method) {
      case 'opencraft/channels/subscribe': {
        fields(params, ['channelId', 'subscriptionId']);
        const { channelId, subscriptionId } = params;
        if (!id(subscriptionId)) throw Error('invalid_input');
        if (channelId !== undefined) await this.#readable(access,channelId);
        authorize();
        const existing = client.subscriptions.get(subscriptionId);
        if (existing ? existing.channelId !== channelId : client.subscriptions.size >= 32) throw Error('invalid_input');
        if (!existing) client.subscriptions.set(subscriptionId, { channelId, checking: false });
        if (!this.#membershipRefresh) {
          const nativeChanges = this.getNative()?.channels;
          if (nativeChanges) this.#unwatch.push(nativeChanges.onChange(change => this.#notify(change)));
          this.#membershipRefresh = setInterval(() => this.#refreshMembership(), 30_000);
          this.#membershipRefresh.unref();
        }
        return null;
      }
      case 'opencraft/channels/unsubscribe':
        fields(params, ['subscriptionId']);
        if (!id(params.subscriptionId)) throw Error('invalid_input');
        client.subscriptions.delete(params.subscriptionId);
        return null;
      default:
        throw Error('method_not_found');
    }
  }

  #notify({ channelId, memberActorId }) {
    for (const [key, client] of this.#clients) {
      for (const [subscriptionId, scope] of client.subscriptions) {
        if (scope.channelId !== undefined && scope.channelId !== channelId) continue;
        if (scope.checking) continue;
        scope.checking = true;
        void Promise.resolve().then(async () => {
          const access = this.#access(client.context);
          // The affected member must refresh even when the change revoked access.
          if (memberActorId !== access.actorContext.actorId) await this.#readable(access,channelId);
          this.#access(client.context);
          if (this.#clients.get(key) === client && client.subscriptions.get(subscriptionId) === scope) {
            this.#emit(key, { method: CHANNELS_CHANGED, params: { subscriptionId } });
          }
        }).catch(() => { /* A retired or unauthorized subscription receives no hint. */ })
          .finally(() => { scope.checking = false; });
      }
    }
  }

  #refreshMembership() {
    for (const [key, client] of this.#clients) {
      for (const [subscriptionId, scope] of client.subscriptions) {
        void Promise.resolve().then(async () => {
          const access = this.#access(client.context);
          let hint = scope.channelId === undefined;
          let revoked = false;
          if (scope.channelId !== undefined) {
            try { await this.#readable(access,scope.channelId); }
            catch (error) {
              // A failed storage/worker read is not proof of revoked access.
              // Keep the subscription so later notifications can recover it.
              revoked = error?.message === 'channel_denied' || error?.status === 401 || error?.status === 403;
              hint = true;
            }
          }
          this.#access(client.context);
          if (hint && this.#clients.get(key) === client && client.subscriptions.get(subscriptionId) === scope) {
            if (revoked) client.subscriptions.delete(subscriptionId);
            this.#emit(key, { method: CHANNELS_CHANGED, params: { subscriptionId } });
          }
        }).catch(() => {});
      }
    }
  }
}
