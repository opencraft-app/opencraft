import { createHash } from "node:crypto";
import { WECOM_POST_TOOL } from "../plugins/wecom/src/post-tool.ts";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code = "wecom_post_denied_or_invalid") => { throw Error(code); };

/** Trusted composition reuses native channel authority; writes own durable receipts. */
export class ImWeComPosts {
  stopped = false;
  abort = new AbortController();
  jobs = new Set();
  constructor(history, receipts) { Object.assign(this, { history, receipts }); }
  call(ref, args, outerSignal) {
    if (this.stopped) return Promise.reject(Error("wecom_post_unavailable"));
    const job = this.send(ref, args, outerSignal);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  async send(ref, args, outerSignal) {
    if (!args || typeof args !== "object" || Array.isArray(args) ||
        Object.keys(args).some(k => !Object.hasOwn(WECOM_POST_TOOL.inputSchema.properties, k)) ||
        WECOM_POST_TOOL.inputSchema.required.some(k => !Object.hasOwn(args, k)) ||
        typeof args.replyRef !== "string" || !args.replyRef || args.replyRef.length > 512 ||
        typeof args.topicId !== "string" || !args.topicId || Buffer.byteLength(args.topicId) > 128 || /[\x00-\x1f\x7f]/u.test(args.topicId) ||
        typeof args.text !== "string" || !args.text.trim() || Buffer.byteLength(args.text) > 20480 || /\$\{inline_(?:file|mention)/u.test(args.text) ||
        typeof args.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(args.requestId)) fail();
    args = { ...args };
    const signal = AbortSignal.any([this.abort.signal, ...(outerSignal ? [outerSignal] : [])]);
    const ctx = await this.history.scope(ref, args.replyRef, signal);
    await ctx.allowed(args.topicId);
    const scope = hash([ref.serverId, ref.threadId, ctx.initial, ctx.channel.botId]);
    const fingerprint = hash([args.topicId, args.text]);
    const receipt = () => {
      const previous = this.receipts.get(scope, args.requestId);
      if (!previous) return null;
      if (previous.fingerprint !== fingerprint) fail("wecom_post_request_conflict");
      if (previous.state !== "delivered") fail("wecom_post_delivery_" + (previous.state === "rejected" ? "rejected" : "unknown"));
      return { status: "delivered", topicId: args.topicId, postId: previous.postId, requestId: args.requestId, deduplicated: true };
    };
    ctx.authorize();
    const existing = receipt();
    if (existing) return existing;
    let claimed = false;
    let postId;
    try {
      postId = await ctx.api.sendPost(args.topicId, args.text, ctx.signal, async () => {
        // Token acquisition and every provider read may yield: recheck immediately before the claim/I/O.
        await ctx.allowed(args.topicId);
        ctx.authorize();
        if (!this.receipts.claim(scope, args.requestId, fingerprint)) {
          receipt();
          fail("wecom_post_request_already_claimed");
        }
        claimed = true;
      });
      this.receipts.finish(scope, args.requestId, "delivered", postId);
    } catch (error) {
      if (claimed) this.receipts.finish(scope, args.requestId,
        error?.code === "wecom_post_provider_rejected" ? "rejected" : "unknown");
      // No provider body, request URL or credential-bearing transport error crosses this boundary.
      if (claimed) fail(error?.code === "wecom_post_provider_rejected" ? "wecom_post_delivery_rejected" : "wecom_post_delivery_unknown");
      throw error;
    }
    ctx.authorize();
    return { status: "delivered", topicId: args.topicId, postId, requestId: args.requestId, deduplicated: false };
  }
  async close() {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled([...this.jobs]);
    this.receipts.close();
  }
}
