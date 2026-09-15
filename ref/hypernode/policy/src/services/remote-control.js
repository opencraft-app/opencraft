import { Service } from "@deepseek-ai/cordis";
import { deferredAppServerResponse } from "./appserver.ts";

const PROTOCOL_VERSION = "3";
const SEGMENT_TARGET_BYTES = 100 * 1024;
const SEGMENT_MAX_BYTES = 150 * 1024;
const REASSEMBLED_MAX_BYTES = 100 * 1024 * 1024;
const SEGMENT_COUNT_MAX = 1024;
const CLIENT_IDLE_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const HTTP_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const ENROLLMENT_NAMESPACE = "remoteControlEnrollment";
const PREFERENCE_NAMESPACE = "remoteControlPreference";

class RemoteControlAuthRequiredError extends Error {
  constructor(username, cause = null) {
    super(`Remote control requires ${username}'s ChatGPT login`);
    this.name = "RemoteControlAuthRequiredError";
    this.cause = cause;
  }
}

export function remoteControlAuthRequiredMessage(user) {
  return `当前 SSH 用户 ${user.username} 尚未绑定 ChatGPT 账户。请打开“☁️ 管理员”，运行“添加 Codex 账户”并完成设备登录。`;
}

function utf8Encode(text) {
  const bytes = [];
  for (const character of String(text)) {
    const value = character.codePointAt(0);
    if (value <= 0x7f) bytes.push(value);
    else if (value <= 0x7ff) bytes.push(0xc0 | (value >>> 6), 0x80 | (value & 0x3f));
    else if (value <= 0xffff) {
      bytes.push(0xe0 | (value >>> 12), 0x80 | ((value >>> 6) & 0x3f), 0x80 | (value & 0x3f));
    } else {
      bytes.push(0xf0 | (value >>> 18), 0x80 | ((value >>> 12) & 0x3f),
        0x80 | ((value >>> 6) & 0x3f), 0x80 | (value & 0x3f));
    }
  }
  return bytes;
}

function utf8Decode(bytes) {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let value;
    if (first < 0x80) value = first;
    else if ((first & 0xe0) === 0xc0 && index < bytes.length) {
      value = ((first & 0x1f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf0) === 0xe0 && index + 1 < bytes.length) {
      value = ((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf8) === 0xf0 && index + 2 < bytes.length) {
      value = ((first & 7) << 18) | ((bytes[index++] & 0x3f) << 12) |
        ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    } else value = 0xfffd;
    result += String.fromCodePoint(value);
  }
  return result;
}

function base64Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    result += alphabet[(value >>> 18) & 63];
    result += alphabet[(value >>> 12) & 63];
    result += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : "=";
    result += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return result;
}

function base64Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(text).replace(/\s+/g, "");
  if (clean.length % 4 !== 0) throw new Error("invalid base64 length");
  const bytes = [];
  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index]);
    const b = alphabet.indexOf(clean[index + 1]);
    const c = clean[index + 2] === "=" ? 0 : alphabet.indexOf(clean[index + 2]);
    const d = clean[index + 3] === "=" ? 0 : alphabet.indexOf(clean[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid base64 data");
    const value = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((value >>> 16) & 0xff);
    if (clean[index + 2] !== "=") bytes.push((value >>> 8) & 0xff);
    if (clean[index + 3] !== "=") bytes.push(value & 0xff);
  }
  return bytes;
}

function normalizeTarget(baseUrl) {
  const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "") + "/";
  const websocketBase = normalized.startsWith("https://")
    ? `wss://${normalized.slice(8)}`
    : normalized.startsWith("http://") ? `ws://${normalized.slice(7)}` : normalized;
  return {
    baseUrl: normalized,
    websocketUrl: `${websocketBase}wham/remote/control/server`,
    enrollUrl: `${normalized}wham/remote/control/server/enroll`,
    refreshUrl: `${normalized}wham/remote/control/server/refresh`,
    pairUrl: `${normalized}wham/remote/control/server/pair`,
    pairStatusUrl: `${normalized}wham/remote/control/server/pair/status`,
  };
}

function readUserAuth(user) {
  if (!user?.username) throw new Error("Remote control requires an authenticated Hypernode user");
  let auth;
  try {
    auth = JSON.parse(utf8Decode(hostIdentity.readCodexAuth(user.username)));
  } catch (error) {
    throw new RemoteControlAuthRequiredError(user.username, error);
  }
  if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token || !auth.tokens?.account_id) {
    throw new RemoteControlAuthRequiredError(user.username);
  }
  return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id };
}

function randomId() {
  const hex = crypto.randomBytes(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

class RemoteSocket {
  constructor(send) {
    this.listeners = new Map();
    this.send = send;
  }

  on(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, value) {
    for (const listener of this.listeners.get(type) || []) listener(value);
  }
}

export class RemoteEnvelopeCodec {
  constructor() {
    this.assemblies = new Map();
  }

  observe(envelope) {
    if (envelope.type !== "client_message_chunk") return { type: "complete", envelope };
    const { client_id: clientId, stream_id: streamId, seq_id: seqId } = envelope;
    const segmentId = envelope.segment_id;
    const segmentCount = envelope.segment_count;
    const messageSize = envelope.message_size_bytes;
    if (!streamId || !Number.isSafeInteger(seqId) || segmentCount < 1 ||
        segmentCount > SEGMENT_COUNT_MAX || segmentId < 0 || segmentId >= segmentCount ||
        messageSize < 1 || messageSize > REASSEMBLED_MAX_BYTES) {
      this.assemblies.delete(clientId);
      return { type: "dropped" };
    }
    const metadata = `${streamId}:${seqId}:${segmentCount}:${messageSize}`;
    let assembly = this.assemblies.get(clientId);
    if (!assembly || assembly.metadata !== metadata) {
      if (segmentId !== 0) return { type: "dropped" };
      assembly = { metadata, next: 0, bytes: [] };
      this.assemblies.set(clientId, assembly);
    }
    if (segmentId < assembly.next) return { type: "pending" };
    if (segmentId !== assembly.next) {
      this.assemblies.delete(clientId);
      return { type: "dropped" };
    }
    const chunk = base64Decode(envelope.message_chunk_base64);
    assembly.bytes.push(...chunk);
    assembly.next += 1;
    if (assembly.bytes.length > messageSize) {
      this.assemblies.delete(clientId);
      return { type: "dropped" };
    }
    if (assembly.next < segmentCount) return { type: "pending" };
    this.assemblies.delete(clientId);
    if (assembly.bytes.length !== messageSize) return { type: "dropped" };
    try {
      return {
        type: "complete",
        envelope: { ...envelope, type: "client_message", message: JSON.parse(utf8Decode(assembly.bytes)) },
      };
    } catch {
      return { type: "dropped" };
    }
  }

  splitServerMessage(envelope) {
    const encodedEnvelope = utf8Encode(JSON.stringify(envelope));
    if (encodedEnvelope.length <= SEGMENT_MAX_BYTES || envelope.type !== "server_message") return [envelope];
    const raw = utf8Encode(JSON.stringify(envelope.message));
    if (raw.length > REASSEMBLED_MAX_BYTES) return [];
    const count = Math.ceil(raw.length / SEGMENT_TARGET_BYTES);
    if (count > SEGMENT_COUNT_MAX) return [];
    const chunkSize = Math.ceil(raw.length / count);
    return Array.from({ length: count }, (_, segmentId) => ({
      type: "server_message_chunk",
      client_id: envelope.client_id,
      stream_id: envelope.stream_id,
      seq_id: envelope.seq_id,
      segment_id: segmentId,
      segment_count: count,
      message_size_bytes: raw.length,
      message_chunk_base64: base64Encode(raw.slice(segmentId * chunkSize, (segmentId + 1) * chunkSize)),
    }));
  }
}

export class RemoteControlChannel {
  constructor(ctx, user) {
    this.ctx = ctx;
    this.user = user;
    this.target = normalizeTarget(hypernodeConfig.remoteControlBaseUrl || "https://chatgpt.com/backend-api");
    this.serverName = "Hypernode";
    this.installationId = user.installationId;
    this.statusValue = "disabled";
    this.environmentId = null;
    this.socketId = null;
    this.enrollment = null;
    this.cursor = null;
    this.reconnectAttempt = 0;
    this.nextReconnectAt = 0;
    this.codec = new RemoteEnvelopeCodec();
    this.clients = new Map();
    this.nextSeq = new Map();
    this.outbound = [];
    this.bootstrapped = false;
    this.enabledPreference = null;
    this.lastErrorKind = null;
    this.lastErrorMessage = null;
    this.requestSequence = 0;
    this.pendingEnrollment = null;

  }

  status() {
    return {
      status: this.statusValue,
      serverName: this.serverName,
      installationId: this.installationId,
      environmentId: this.environmentId,
    };
  }

  publish(status) {
    if (this.statusValue === status) return this.status();
    this.statusValue = status;
    for (const connection of this.ctx.appServer.connections) {
      if (connection.identity?.id === this.user.id) {
        connection.socket.send({ method: "remoteControl/status/changed", params: this.status() });
      }
    }
    return this.status();
  }

  authHeaders(auth) {
    return {
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "x-codex-installation-id": this.installationId,
    };
  }

  jsonTask(method, url, headers = {}, body = null, transform = (value) => value) {
    const requestId = `remote-control-http:${this.user.id}:${++this.requestSequence}`;
    const responseBytes = [];
    let status = 0;
    this.ctx.httpClient.open(requestId, {
      method,
      url,
      headers: {
        accept: "application/json",
        ...(body == null ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    return {
      cancel: () => this.ctx.httpClient.close(requestId),
      poll: () => {
        const drained = this.ctx.httpClient.drain(requestId);
        if (drained.status > 0) status = drained.status;
        responseBytes.push(...drained.dataBytes);
        if (responseBytes.length > HTTP_RESPONSE_MAX_BYTES) {
          this.ctx.httpClient.close(requestId);
          throw new Error("Remote response body exceeds limit");
        }
        if (drained.error) {
          this.ctx.httpClient.close(requestId);
          throw new Error(`Remote request failed at ${url}: ${drained.error}`);
        }
        if (!drained.closed) return null;
        if (status < 200 || status >= 300) {
          throw new Error(`Remote request failed: HTTP ${status} at ${url}`);
        }
        let response = {};
        if (responseBytes.length > 0) {
          try {
            response = JSON.parse(utf8Decode(responseBytes));
          } catch (error) {
            throw new Error(`Remote response was not JSON at ${url}: ${error.message}`);
          }
        }
        return transform(response);
      },
    };
  }

  enrollmentKey(accountId) {
    return `${this.user.id}:${this.installationId}:${accountId}:${this.target.websocketUrl}`;
  }

  loadEnrollment(auth) {
    const encoded = policyStore.get(ENROLLMENT_NAMESPACE, this.enrollmentKey(auth.accountId));
    if (!encoded) return null;
    try {
      const enrollment = JSON.parse(encoded);
      return enrollment.accountId === auth.accountId ? enrollment : null;
    } catch {
      return null;
    }
  }

  persistEnrollment(enrollment) {
    policyStore.set(ENROLLMENT_NAMESPACE, this.enrollmentKey(enrollment.accountId), JSON.stringify(enrollment));
  }

  beginEnrollmentRequest(kind, auth, enrollment = null) {
    const requestId = `remote-control-enrollment:${this.user.id}:${++this.requestSequence}`;
    const url = kind === "enroll" ? this.target.enrollUrl : this.target.refreshUrl;
    const body = kind === "enroll" ? {
      name: this.serverName,
      os: "linux",
      arch: "x86_64",
      app_server_version: "0.148.0-alpha.21",
      installation_id: this.installationId,
    } : {
      server_id: enrollment.serverId,
      installation_id: this.installationId,
    };
    this.ctx.httpClient.open(requestId, {
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...this.authHeaders(auth) },
      body: JSON.stringify(body),
    });
    this.pendingEnrollment = {
      requestId, kind, auth, enrollment, url, status: 0, responseBytes: [],
    };
  }

  finishEnrollmentRequest() {
    const pending = this.pendingEnrollment;
    if (!pending) return false;
    const drained = this.ctx.httpClient.drain(pending.requestId);
    if (drained.status > 0) pending.status = drained.status;
    pending.responseBytes.push(...drained.dataBytes);
    if (pending.responseBytes.length > HTTP_RESPONSE_MAX_BYTES) {
      this.ctx.httpClient.close(pending.requestId);
      this.pendingEnrollment = null;
      throw new Error("Remote response body exceeds limit");
    }
    if (drained.error) {
      this.ctx.httpClient.close(pending.requestId);
      this.pendingEnrollment = null;
      throw new Error(`Remote request failed at ${pending.url}: ${drained.error}`);
    }
    if (!drained.closed) return false;
    this.pendingEnrollment = null;
    if (pending.status < 200 || pending.status >= 300) {
      throw new Error(`Remote request failed: HTTP ${pending.status} at ${pending.url}`);
    }
    let response;
    try {
      response = JSON.parse(utf8Decode(pending.responseBytes));
    } catch (error) {
      throw new Error(`Remote response was not JSON at ${pending.url}: ${error.message}`);
    }
    let enrollment;
    if (pending.kind === "enroll") {
      enrollment = {
        accountId: pending.auth.accountId,
        serverId: response.server_id,
        environmentId: response.environment_id,
        token: response.remote_control_token,
        expiresAt: Date.parse(response.expires_at),
      };
    } else {
      enrollment = { ...pending.enrollment };
      if (response.server_id !== enrollment.serverId || response.environment_id !== enrollment.environmentId) {
        throw new Error("Remote refresh changed enrollment identity");
      }
      enrollment.token = response.remote_control_token;
      enrollment.expiresAt = Date.parse(response.expires_at);
    }
    if (!enrollment.serverId || !enrollment.environmentId || !enrollment.token || !Number.isFinite(enrollment.expiresAt)) {
      throw new Error("Remote enrollment response is incomplete");
    }
    this.persistEnrollment(enrollment);
    this.enrollment = enrollment;
    this.environmentId = enrollment.environmentId;
    return true;
  }

  prepareEnrollment() {
    const auth = readUserAuth(this.user);
    let enrollment = this.loadEnrollment(auth);
    if (!enrollment) {
      this.beginEnrollmentRequest("enroll", auth);
      return false;
    }
    if (!enrollment.token || enrollment.expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
      this.beginEnrollmentRequest("refresh", auth, enrollment);
      return false;
    }
    this.enrollment = enrollment;
    this.environmentId = enrollment.environmentId;
    return true;
  }

  enable(ephemeral = false) {
    if (!ephemeral) {
      policyStore.set(PREFERENCE_NAMESPACE, `${this.user.id}:enabled`, "true");
      this.enabledPreference = true;
    }
    if (this.pendingEnrollment) return this.status();
    try {
      const ready = this.prepareEnrollment();
      this.lastErrorKind = null;
      this.lastErrorMessage = null;
      this.publish("connecting");
      if (ready) this.connect();
    } catch (error) {
      this.lastErrorMessage = error.message || String(error);
      if (error instanceof RemoteControlAuthRequiredError) {
        this.lastErrorKind = "accountNotBound";
        // Authentication cannot recover by retrying the same credentials. Keep
        // the persisted preference, but wait for an explicit enable after the
        // user binds or switches accounts instead of blocking every policy tick.
        this.nextReconnectAt = Number.POSITIVE_INFINITY;
        this.publish("disabled");
      } else if (this.statusValue === "disabled") {
        // A bootstrap failure cannot be repaired by spinning on every policy
        // tick. A later explicit enable retries with fresh account state.
        this.lastErrorKind = "connectionFailed";
        this.nextReconnectAt = Number.POSITIVE_INFINITY;
      } else {
        this.lastErrorKind = "connectionFailed";
        this.scheduleReconnect(error);
      }
    }
    return this.status();
  }

  disable(ephemeral = false) {
    if (!ephemeral) {
      policyStore.set(PREFERENCE_NAMESPACE, `${this.user.id}:enabled`, "false");
      this.enabledPreference = false;
    }
    if (this.pendingEnrollment) {
      this.ctx.httpClient.close(this.pendingEnrollment.requestId);
      this.pendingEnrollment = null;
    }
    if (this.socketId) hostNetwork.closeWebSocket(this.socketId);
    this.socketId = null;
    for (const client of this.clients.values()) client.socket.emit("close");
    this.clients.clear();
    this.publish("disabled");
    return this.status();
  }

  connect() {
    if (!this.enrollment) throw new Error("Remote enrollment is unavailable");
    if (this.socketId) hostNetwork.closeWebSocket(this.socketId);
    const socketId = `remote-control-${randomId()}`;
    const headers = {
      "x-codex-server-id": this.enrollment.serverId,
      "x-codex-name": base64Encode(utf8Encode(this.serverName)),
      "x-codex-protocol-version": PROTOCOL_VERSION,
      authorization: `Bearer ${this.enrollment.token}`,
      "x-codex-installation-id": this.installationId,
    };
    if (this.cursor) headers["x-codex-subscribe-cursor"] = this.cursor;
    hostNetwork.openWebSocket(socketId, this.target.websocketUrl, headers);
    this.socketId = socketId;
    this.reconnectAttempt = 0;
    this.publish("connected");
    this.replayOutbound();
  }

  scheduleReconnect() {
    if (this.statusValue === "disabled") return;
    if (this.socketId) hostNetwork.closeWebSocket(this.socketId);
    this.socketId = null;
    const delay = Math.min(30_000, 500 * (2 ** Math.min(this.reconnectAttempt, 6)));
    this.reconnectAttempt = (this.reconnectAttempt + 1) % 7;
    this.nextReconnectAt = Date.now() + delay;
    this.publish("errored");
  }

  tick() {
    if (this.enabledPreference == null) {
      this.enabledPreference = policyStore.get(PREFERENCE_NAMESPACE, `${this.user.id}:enabled`) === "true";
    }
    if (!this.bootstrapped) {
      this.bootstrapped = true;
      if (this.enabledPreference) this.enable(true);
    }
    if (this.pendingEnrollment) {
      try {
        if (!this.finishEnrollmentRequest()) return;
        this.connect();
      } catch (error) {
        this.lastErrorKind = "connectionFailed";
        this.lastErrorMessage = error.message || String(error);
        this.nextReconnectAt = Number.POSITIVE_INFINITY;
        this.publish("disabled");
        return;
      }
    }
    if (this.statusValue === "disabled") {
      if (this.enabledPreference
        && this.lastErrorKind !== "accountNotBound"
        && Date.now() >= this.nextReconnectAt) this.enable(true);
      return;
    }
    if (!this.socketId) {
      if (Date.now() >= this.nextReconnectAt) this.enable(true);
      return;
    }
    let drained;
    try {
      drained = hostNetwork.drainWebSocket(this.socketId);
    } catch {
      this.scheduleReconnect();
      return;
    }
    for (const text of drained.messages || []) this.onWireMessage(text);
    this.sweepIdleClients();
    if (drained.closed) this.scheduleReconnect();
  }

  onWireMessage(text) {
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof envelope.cursor === "string") this.cursor = envelope.cursor;
    if (envelope.type === "ack") {
      this.ack(envelope);
      return;
    }
    const observation = this.codec.observe(envelope);
    if (observation.type !== "complete") return;
    envelope = observation.envelope;
    const key = `${envelope.client_id}:${envelope.stream_id || ""}`;
    if (envelope.type === "ping") {
      this.sendEvent(envelope.client_id, envelope.stream_id || randomId(), {
        type: "pong", status: this.clients.has(key) ? "active" : "unknown",
      });
      return;
    }
    if (envelope.type === "client_closed") {
      this.closeClient(key);
      return;
    }
    if (envelope.type !== "client_message" || !envelope.stream_id) return;
    let client = this.clients.get(key);
    const initialize = envelope.message?.method === "initialize";
    if (initialize && client) this.closeClient(key);
    client = this.clients.get(key);
    if (!client && !initialize) return;
    if (!client) client = this.openClient(envelope.client_id, envelope.stream_id);
    client.lastActivityAt = Date.now();
    client.socket.emit("message", JSON.stringify(envelope.message));
  }

  openClient(clientId, streamId) {
    const key = `${clientId}:${streamId}`;
    const socket = new RemoteSocket((message) => {
      const parsed = typeof message === "string" ? JSON.parse(message) : message;
      this.sendEvent(clientId, streamId, { type: "server_message", message: parsed });
    });
    const client = { clientId, streamId, socket, lastActivityAt: Date.now() };
    this.clients.set(key, client);
    this.ctx.appServer.attach(socket, {
      connectionId: `remote:${this.user.id}:${key}`,
      identity: { ...this.user, registered: true, authentication: "remote-control" },
    });
    return client;
  }

  closeClient(key) {
    const client = this.clients.get(key);
    if (!client) return;
    this.clients.delete(key);
    client.socket.emit("close");
  }

  sweepIdleClients() {
    const cutoff = Date.now() - CLIENT_IDLE_MS;
    for (const [key, client] of this.clients) {
      if (client.lastActivityAt < cutoff) this.closeClient(key);
    }
  }

  sendEvent(clientId, streamId, event) {
    const key = `${clientId}:${streamId}`;
    const seqId = this.nextSeq.get(key) || 1;
    this.nextSeq.set(key, seqId + 1);
    const envelopes = this.codec.splitServerMessage({ ...event, client_id: clientId, stream_id: streamId, seq_id: seqId });
    for (const envelope of envelopes) {
      this.outbound.push(envelope);
      if (this.socketId) hostNetwork.sendWebSocket(this.socketId, JSON.stringify(envelope));
    }
  }

  ack(envelope) {
    if (!envelope.stream_id || !Number.isSafeInteger(envelope.seq_id)) return;
    const segment = envelope.segment_id == null ? Number.MAX_SAFE_INTEGER : envelope.segment_id;
    this.outbound = this.outbound.filter((queued) => queued.client_id !== envelope.client_id ||
      queued.stream_id !== envelope.stream_id || queued.seq_id > envelope.seq_id ||
      (queued.seq_id === envelope.seq_id && (queued.segment_id ?? Number.MAX_SAFE_INTEGER) > segment));
  }

  replayOutbound() {
    for (const envelope of this.outbound) hostNetwork.sendWebSocket(this.socketId, JSON.stringify(envelope));
  }

  startPairing(params = {}) {
    if (!this.enrollment || this.statusValue === "disabled") throw new Error("remote control pairing requires remote control to be enabled");
    return this.jsonTask("POST", this.target.pairUrl, { authorization: `Bearer ${this.enrollment.token}` }, {
      manual_code: params.manualCode === true,
    }, (response) => {
      if (response.server_id !== this.enrollment.serverId || response.environment_id !== this.enrollment.environmentId) {
        throw new Error("Remote pairing changed enrollment identity");
      }
      return {
        pairingCode: response.pairing_code,
        manualPairingCode: response.manual_pairing_code ?? null,
        environmentId: response.environment_id,
        expiresAt: Math.floor(Date.parse(response.expires_at) / 1000),
      };
    });
  }

  pairingStatus(params = {}) {
    if (!this.enrollment || this.statusValue === "disabled") throw new Error("remote control pairing requires remote control to be enabled");
    return this.jsonTask("POST", this.target.pairStatusUrl, { authorization: `Bearer ${this.enrollment.token}` }, {
      pairing_code: params.pairingCode ?? undefined,
      manual_pairing_code: params.manualPairingCode ?? undefined,
    });
  }

  clientManagementUrl(environmentId, clientId = null) {
    if (!environmentId) throw new Error("remote control client request requires environmentId");
    const base = `${this.target.baseUrl}wham/remote/control/environments/${encodeURIComponent(environmentId)}/clients`;
    return clientId == null ? base : `${base}/${encodeURIComponent(clientId)}`;
  }

  listClients(params = {}) {
    if (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) {
      throw new Error("remote control client list limit must be between 1 and 100");
    }
    const query = [];
    if (params.cursor != null) query.push(`cursor=${encodeURIComponent(params.cursor)}`);
    if (params.limit != null) query.push(`limit=${params.limit}`);
    if (params.order != null) query.push(`order=${encodeURIComponent(params.order)}`);
    const auth = readUserAuth(this.user);
    const url = this.clientManagementUrl(params.environmentId) + (query.length ? `?${query.join("&")}` : "");
    return this.jsonTask("GET", url, this.authHeaders(auth), null, (response) => ({
      data: (response.items || []).map((client) => ({
        clientId: client.client_id,
        displayName: client.display_name ?? null,
        deviceType: client.device_type ?? null,
        platform: client.platform ?? null,
        osVersion: client.os_version ?? null,
        deviceModel: client.device_model ?? null,
        appVersion: client.app_version ?? null,
        lastSeenAt: client.last_seen_at == null ? null : Math.floor(Date.parse(client.last_seen_at) / 1000),
      })),
      nextCursor: response.cursor ?? null,
    }));
  }

  revokeClient(params = {}) {
    if (!params.clientId) throw new Error("remote control client revoke requires clientId");
    const auth = readUserAuth(this.user);
    return this.jsonTask(
      "DELETE",
      this.clientManagementUrl(params.environmentId, params.clientId),
      this.authHeaders(auth),
      null,
      () => ({}),
    );
  }
}

export class RemoteControlService extends Service {
  constructor(ctx) {
    super(ctx, "remoteControl");
    this.channels = new Map();
    this.pendingRequests = new Set();
    ctx.effect(() => () => {
      for (const pending of this.pendingRequests) pending.task.cancel();
      this.pendingRequests.clear();
    });
    const register = (method, handler) => ctx.effect(() => ctx.appServer.register(
      method,
      (params, connection) => handler(this.channelFor(connection), params ?? {}, connection),
    ));
    const registerAsync = (method, handler) => register(method, (channel, params) => {
      const task = handler(channel, params);
      return deferredAppServerResponse(({ resolve, reject }) => {
        this.pendingRequests.add({ task, resolve, reject, deadlineAt: Date.now() + 30_000 });
      });
    });
    register("remoteControl/enable", (channel, params, connection) => {
      const status = channel.enable(params.ephemeral === true);
      if (channel.lastErrorKind === "accountNotBound") {
        const message = remoteControlAuthRequiredMessage(channel.user);
        ctx.appServer.notifyAfter(connection, "warning", {
          threadId: null,
          message,
        });
        const managementThread = ctx.threadManager.list().find((thread) => ctx.threadManager.isRoot(thread.id));
        if (managementThread) {
          ctx.userDirectory.deliverAgentMessage(connection, managementThread.id, {
            deliveryText: message,
            persistedText: message,
          });
        }
      }
      return status;
    });
    register("remoteControl/disable", (channel, params) => channel.disable(params.ephemeral === true));
    register("remoteControl/status/read", (channel) => channel.status());
    registerAsync("remoteControl/pairing/start", (channel, params) => channel.startPairing(params));
    registerAsync("remoteControl/pairing/status", (channel, params) => channel.pairingStatus(params));
    registerAsync("remoteControl/client/list", (channel, params) => channel.listClients(params));
    registerAsync("remoteControl/client/revoke", (channel, params) => channel.revokeClient(params));
  }

  userFor(connection) {
    const userId = connection?.identity?.id;
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!user) throw new Error("Remote control requires an authenticated Hypernode user");
    return user;
  }

  channelFor(connection) {
    return this.channelForUser(this.userFor(connection));
  }

  channelForUser(user) {
    let channel = this.channels.get(user.id);
    if (!channel || channel.installationId !== user.installationId) {
      if (channel) channel.disable(true);
      channel = new RemoteControlChannel(this.ctx, user);
      this.channels.set(user.id, channel);
    } else {
      channel.user = user;
    }
    return channel;
  }

  statusForUser(userId) {
    const user = this.ctx.userDirectory.find(userId);
    return user ? this.channelForUser(user).status() : null;
  }

  tick() {
    for (const user of this.ctx.userDirectory.list()) this.channelForUser(user).tick();
    for (const pending of [...this.pendingRequests]) {
      try {
        if (Date.now() >= pending.deadlineAt) throw new Error("Remote request timed out");
        const result = pending.task.poll();
        if (result == null) continue;
        this.pendingRequests.delete(pending);
        pending.resolve(result);
      } catch (error) {
        this.pendingRequests.delete(pending);
        pending.task.cancel();
        pending.reject(error);
      }
    }
  }
}

RemoteControlService.inject = ["appServer", "httpClient", "threadManager", "userDirectory"];
