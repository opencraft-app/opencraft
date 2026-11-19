import { botBinding, assertBotBinding } from "../domain/bot-binding.mjs";

const id = (value) => {
  if (typeof value !== "string" || value.length > 256 || !value || /[\0\r\n]/u.test(value))
    throw Error("Invalid channel identity");
  return value;
};
/** A caller cannot supply actor credentials, ownership, a file path, or an alternate server.
 * The authenticated host port owns authorization and native history; this client has no cache/DB.
 * authorize returns {binding,epoch,expiresAt}; epoch changes when assignment/access is retired.
 * request runs under the host's authenticated Bot Actor and enforces membership itself.
 */
export class PlatformChannels {
  constructor(binding, port, { now = Date.now, assertWriter = () => {} } = {}) {
    this.binding = botBinding(binding);
    this.port = port;
    this.now = now;
    this.assertWriter = assertWriter;
  }
  async authorized(signal) {
    signal?.throwIfAborted();
    this.assertWriter();
    const access = await this.port.authorize(this.binding, signal);
    signal?.throwIfAborted();
    this.assertWriter();
    assertBotBinding(access?.binding, this.binding);
    if (
      typeof access.epoch !== "string" ||
      !access.epoch ||
      !Number.isSafeInteger(access.expiresAt) ||
      access.expiresAt <= this.now()
    )
      throw Error("Bot authority expired");
    return access;
  }
  async call(method, params, signal) {
    const before = await this.authorized(signal);
    const result = await this.port.request(this.binding, method, params, signal);
    const after = await this.authorized(signal);
    if (before.epoch !== after.epoch) throw Error("Bot authority changed during request");
    return result;
  }
  list(signal) {
    return this.call("opencraft/personal-assistant/groups/list", {}, signal);
  }
  history(channelId, { before } = {}, signal) {
    return this.call(
      "opencraft/personal-assistant/groups/history",
      { channelId: id(channelId), ...(before === undefined ? {} : { before }) },
      signal,
    );
  }
  search(channelId, { query, before, limit = 20 } = {}, signal) {
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.length > 256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw Error("Invalid bounded channel search");
    return this.call(
      "opencraft/personal-assistant/groups/search",
      {
        channelId: id(channelId),
        query,
        limit,
        ...(before === undefined ? {} : { before }),
      },
      signal,
    );
  }
  send() {
    throw Error("Personal assistant delegation is read-only");
  }
  query(name, params = {}, signal) {
    switch (name) {
      case "platform.groups.list":
        return this.list(signal);
      case "platform.groups.history":
        return this.history(params.channelId, params, signal);
      case "platform.groups.search":
        return this.search(params.channelId, params, signal);
      case "platform.conversations.list":
        return this.call("opencraft/personal-assistant/conversations/list", params, signal);
      case "platform.conversations.history":
        return this.call("opencraft/personal-assistant/conversations/history", params, signal);
      default:
        throw Error("Unknown platform read operation");
    }
  }
  reference(channelId, messageId) {
    return Object.freeze({
      serverId: this.binding.serverId,
      channelId: id(channelId),
      messageId: id(messageId),
    });
  }
}
