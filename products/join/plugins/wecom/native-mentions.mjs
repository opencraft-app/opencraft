import { utf8Chunks } from "./text-chunks.mjs";
/** Provider identifiers are selected by the installation's verified identity binding,
 * never inferred from display names or model-generated @text. */
export function nativeMentionRecipients(service, _db, delivery, mentions) {
  let corp;
  try {
    const s = JSON.parse(delivery.source);
    if (s[0] !== "wecom-customer-service") return [];
    corp = s[1];
  } catch {
    return [];
  }
  return mentions.flatMap((m) => {
    if (!service.channels.isMember(String(delivery.channel_id), m.actorId))
      return [];
    const ids = service.actors
      .bindings(m.actorId)
      .filter((b) => b.provider === "wecom." + corp)
      .map((b) => b.subject);
    return ids.length === 1 &&
      /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(ids[0]) &&
      !/^(all$|wb|fw|external:)/iu.test(ids[0])
      ? [{ start: m.start, end: m.end, recipient: ids[0] }]
      : [];
  });
}
export function checkedNativeMentions(text, value) {
  if (!Array.isArray(value) || value.length > 32)
    throw Error("Invalid native mentions");
  let previous = 0;
  return value.map((m) => {
    if (
      !m ||
      Object.keys(m).some((k) => !["start", "end", "recipient"].includes(k)) ||
      !Number.isSafeInteger(m.start) ||
      !Number.isSafeInteger(m.end) ||
      m.start < previous ||
      m.end <= m.start ||
      m.end > text.length ||
      text[m.start] !== "@" ||
      typeof m.recipient !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(m.recipient) ||
      /^(all$|external:)/iu.test(m.recipient)
    )
      throw Error("Invalid native mentions");
    previous = m.end;
    return { start: m.start, end: m.end, recipient: m.recipient };
  });
}
/** Stay below provider text/part limits. The same-frame mentioned node is the real
 * notification; never append a second canned ping or convert ordinary @text. */
export function nativeMentionFrames(text, mentions, prefix) {
  const frames = [];
  let frame = [],
    budget = 0;
  const flush = () => {
    if (frame.length > 1) frames.push(frame);
    frame = [{ type: "text", text: { content: prefix } }];
    budget = 5000 - Buffer.byteLength(prefix);
  };
  flush();
  const push = (part, cost) => {
    if (frame.length >= 30 || cost > budget) flush();
    frame.push(part);
    budget -= cost;
  };
  const plain = (value) => {
    for (const chunk of utf8Chunks(value, 3000))
      push(
        { type: "text", text: { content: chunk } },
        Buffer.byteLength(chunk),
      );
  };
  let offset = 0;
  for (const m of mentions) {
    plain(text.slice(offset, m.start));
    push({ type: "mentioned", mentioned: { userlist: [m.recipient] } }, 128);
    offset = m.end;
  }
  plain(text.slice(offset));
  flush();
  return frames;
}
