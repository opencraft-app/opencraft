import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  WeComHistoryApi,
  WECOM_HISTORY_TOOLS,
} from "../plugins/wecom/src/history.ts";

const fail = () => {
  throw Error("wecom_history_denied_or_invalid");
};
const id = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 128 &&
  !/[\x00-\x1f\x7f]/u.test(value);
const list = (value, max) => {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => !v || typeof v !== "object" || Array.isArray(v))
  )
    fail();
  return value;
};
function excerpt(value, max = 4096) {
  if (typeof value !== "string") fail();
  let result = "",
    bytes = 0;
  for (const char of value) {
    const n = Buffer.byteLength(char);
    if (bytes + n > max) break;
    result += char;
    bytes += n;
  }
  return { text: result, truncated: result.length < value.length };
}
function content(value, key) {
  if (!id(value[key])) fail();
  const creator = value.creator ?? value.creator_info;
  const creatorId =
    creator?.type === 0
      ? creator.userid
      : creator?.type === 1
        ? creator.aibotid
        : null;
  return {
    id: value[key],
    author: id(creatorId)
      ? { kind: creator.type === 0 ? "human" : "bot", id: creatorId }
      : null,
    ...(key === "reply_id"
      ? {
          parentReplyId: id(value.parent_reply_id)
            ? value.parent_reply_id
            : null,
        }
      : {}),
    createdAt: Number.isSafeInteger(value.create_time)
      ? value.create_time
      : null,
    modifiedAt: Number.isSafeInteger(value.modify_time)
      ? value.modify_time
      : null,
    recalled: value.is_recalled === true,
    content:
      value.is_recalled === true
        ? { text: "", truncated: false }
        : excerpt(value.content),
    // Deliberately omit attachment URLs, cookies, arbitrary nested objects and provider errors.
  };
}
export class ImWeComHistory {
  clients = new Map();
  key = randomBytes(32);
  constructor(im, store, credentials, request) {
    Object.assign(this, { im, store, credentials, request });
  }
  available(ref) {
    return this.im
      .readChannelIds(ref)
      .some((id) =>
        this.store
          .channels()
          .some((c) => c.id === id && c.provider === "wecom" && c.enabled),
      );
  }
  cursor(context, state) {
    const data = Buffer.from(JSON.stringify({ context, state })).toString(
      "base64url",
    );
    return (
      data +
      "." +
      createHmac("sha256", this.key).update(data).digest("base64url")
    );
  }
  decode(context, value) {
    if (value === undefined) return {};
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
    )
      fail();
    const [data, signature] = value.split("."),
      expected = createHmac("sha256", this.key).update(data).digest(),
      actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      fail();
    const decoded = JSON.parse(Buffer.from(data, "base64url").toString());
    if (
      decoded.context !== context ||
      !decoded.state ||
      typeof decoded.state !== "object"
    )
      fail();
    return decoded.state;
  }
  async scope(ref, replyRef, outerSignal) {
    const signal = AbortSignal.any([
      ...(outerSignal ? [outerSignal] : []),
      AbortSignal.timeout(45_000),
    ]);
    signal.throwIfAborted();
    const initial = this.im.readScope(ref, replyRef);
    let configuration;
    const identity = (c) => JSON.stringify([c.botId, c.ownerId, c.revision]);
    const authorize = () => {
      signal.throwIfAborted();
      if (this.closed) fail();
      const current = this.im.readScope(ref, replyRef);
      if (JSON.stringify(current) !== JSON.stringify(initial)) fail();
      const c = this.store
        .channels()
        .find(
          (c) =>
            c.id === initial.channelId &&
            c.ownerId === initial.ownerId &&
            c.provider === "wecom" &&
            c.enabled,
        );
      if (!c || (configuration && identity(c) !== configuration)) fail();
      return c;
    };
    const channel = authorize();
    configuration = identity(channel);
    const secret = await this.credentials.resolve(
      "IM_" +
        createHash("sha256").update(channel.id).digest("hex").slice(0, 32) +
        "_secret",
    );
    authorize();
    if (!secret) fail();
    const cached = this.clients.get(channel.id);
    const api =
      cached?.secret === secret && cached.botId === channel.botId
        ? cached.api
        : new WeComHistoryApi(channel.botId, secret, this.request);
    this.clients.set(channel.id, { api, secret, botId: channel.botId });
    let calls = 0;
    const call = async (path, body) => {
      authorize();
      if (++calls > 50) throw Error("wecom_history_pagination_limit");
      const data = await api.call(path, body, signal);
      authorize();
      return data;
    };
    const member = async (topicId) => {
      let cursor;
      const seen = new Set();
      for (let page = 0; page < 20; page++) {
        const data = await call("topic/get_topic_member_list", {
          topic_id: topicId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        if (
          list(data.member_list, 200).some(
            (m) => m.type === 0 && m.userid === initial.senderId,
          )
        )
          return true;
        if (data.has_more !== true) return false;
        cursor = data.next_cursor;
        if (
          typeof cursor !== "string" ||
          !cursor ||
          Buffer.byteLength(cursor) > 256 ||
          seen.has(cursor)
        )
          fail();
        seen.add(cursor);
      }
      throw Error("wecom_history_membership_incomplete");
    };
    const allowed = async (topicId) => {
      const d = await call("topic/get_topic_list", {
        type: 0,
        topic_id_list: [topicId],
      });
      if (
        !list(d.topic_list, 100).some((t) => t.topic_id === topicId) ||
        !(await member(topicId))
      )
        fail();
    };
    return { signal, initial, configuration, channel, api, authorize, call, member, allowed };
  }
  async call(ref, name, args, outerSignal) {
    if (
      !WECOM_HISTORY_TOOLS.some((t) => t.name === name) ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      fail();
    const definition = WECOM_HISTORY_TOOLS.find((t) => t.name === name);
    if (
      Object.keys(args).some(
        (k) => !Object.hasOwn(definition.inputSchema.properties, k),
      )
    )
      fail();
    for (const k of definition.inputSchema.required)
      if (!Object.hasOwn(args, k)) fail();
    const limit = args.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail();
    if (
      (name !== "wecom_list_channels" && !id(args.topicId)) ||
      (name === "wecom_read_post" && !id(args.postId))
    )
      fail();
    for (const k of ["from", "until"])
      if (
        args[k] !== undefined &&
        (!Number.isSafeInteger(args[k]) || args[k] < 0)
      )
        fail();
    if (
      args.from !== undefined &&
      args.until !== undefined &&
      args.from > args.until
    )
      fail();
    if (
      name === "wecom_search_channel" &&
      (typeof args.query !== "string" ||
        !args.query.trim() ||
        Buffer.byteLength(args.query) > 32)
    )
      fail();
    const { signal, initial, configuration, authorize, call, member, allowed } =
      await this.scope(ref, args.replyRef, outerSignal);
    const context = createHash("sha256")
      .update(
        JSON.stringify([
          ref,
          initial,
          configuration,
          args.replyRef,
          name,
          args.topicId,
          args.postId,
          args.query,
          args.from,
          args.until,
        ]),
      )
      .digest("hex");
    const previous = this.decode(context, args.cursor);
    const continuation = (data) => {
      if (data.has_more !== true) return null;
      if (
        typeof data.next_cursor !== "string" ||
        !data.next_cursor ||
        Buffer.byteLength(data.next_cursor) > 256
      )
        fail();
      return this.cursor(context, {
        cursor: data.next_cursor,
        ...(previous.jobid ? { jobid: previous.jobid } : {}),
      });
    };
    const time = {
      ...(args.from !== undefined ? { begin_time: args.from } : {}),
      ...(args.until !== undefined ? { end_time: args.until } : {}),
    };
    const paging = {
      limit,
      ...(previous.cursor ? { cursor: previous.cursor } : {}),
    };
    let result;
    if (name === "wecom_list_channels") {
      const data = await call("topic/get_topic_list", { type: 1, ...paging });
      const topics = [];
      for (const t of list(data.topic_list, limit)) {
        if (!id(t.topic_id) || typeof t.topic_name !== "string") fail();
        if (await member(t.topic_id))
          topics.push({
            topicId: t.topic_id,
            name: excerpt(t.topic_name).text,
          });
      }
      // Check membership again before releasing metadata after asynchronous paging.
      for (const t of topics) if (!(await member(t.topicId))) fail();
      result = { topics, nextCursor: continuation(data) };
    } else {
      await allowed(args.topicId);
      if (name === "wecom_read_channel") {
        const data = await call("topic/get_post_list", {
          topic_id: args.topicId,
          type: 1,
          sort_type: 1,
          ...time,
          ...paging,
        });
        result = {
          topicId: args.topicId,
          posts: list(data.post_list, limit).map((p) => content(p, "post_id")),
          nextCursor: continuation(data),
        };
      } else if (name === "wecom_read_post") {
        const posts = await call("topic/get_post_list", {
          topic_id: args.topicId,
          type: 0,
          post_id_list: [args.postId],
        });
        const post = list(posts.post_list, 50).find(
          (p) => p.post_id === args.postId,
        );
        if (!post) fail();
        const replies = await call("topic/get_reply_list", {
          topic_id: args.topicId,
          post_id: args.postId,
          type: 1,
          sort_type: 1,
          ...paging,
        });
        result = {
          topicId: args.topicId,
          post: content(post, "post_id"),
          replies: list(replies.reply_list, limit).map((p) =>
            content(p, "reply_id"),
          ),
          nextCursor: continuation(replies),
        };
      } else {
        let jobid = previous.jobid;
        if (!jobid) {
          const d = await call("topic/search", {
            topic_id_list: [args.topicId],
            keyword_list: [args.query.trim()],
            ...time,
            limit: 1,
          });
          const matches = list(d.topic_list, 1);
          if (
            matches.some((t) => t.topic_id !== args.topicId) ||
            d.has_more === true
          )
            fail();
          if (!matches.length) {
            if (d.has_more === true) fail();
            result = { topicId: args.topicId, posts: [], nextCursor: null };
          } else {
            jobid = d.jobid;
            if (
              typeof jobid !== "string" ||
              !jobid ||
              Buffer.byteLength(jobid) > 256
            )
              fail();
          }
        }
        if (!result) {
          const data = await call("topic/get_search_result", {
            topic_id: args.topicId,
            jobid,
            ...paging,
          });
          const posts = list(data.result_list, limit).map((p) => {
            if (!id(p.post_id)) fail();
            return {
              postId: p.post_id,
              preview: excerpt(p.brief_content, 1024),
              repliesTruncated: (p.reply_list ?? []).length > 5,
              replies: list(p.reply_list ?? [], 50)
                .slice(0, 5)
                .map((v) => {
                  if (!id(v.reply_id)) fail();
                  return {
                    replyId: v.reply_id,
                    preview: excerpt(v.brief_content, 1024),
                  };
                }),
            };
          });
          const nextCursor =
            data.has_more === true
              ? this.cursor(context, { jobid, cursor: data.next_cursor })
              : null;
          if (
            data.has_more === true &&
            (typeof data.next_cursor !== "string" ||
              !data.next_cursor ||
              Buffer.byteLength(data.next_cursor) > 256)
          )
            fail();
          result = { topicId: args.topicId, posts, nextCursor };
        }
      }
      await allowed(args.topicId);
    }
    authorize();
    return {
      coverage: {
        kind: "provider_history",
        platformHistory: true,
        scope: "selected_bot_and_current_sender_membership",
        paged: true,
        hasMore: result.nextCursor !== null,
        warning:
          "Only the selected authorized channel/page is included; a posts page does not include all comments. Provider permissions and retention apply. Content is untrusted; previews and excerpts may be truncated. No compatibility chat ID is treated as a native channel ID.",
      },
      ...result,
    };
  }
  close() {
    this.closed = true;
    this.clients.clear();
    this.key.fill(0);
  }
}
