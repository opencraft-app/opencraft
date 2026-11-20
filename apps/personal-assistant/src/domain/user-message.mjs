import { requireText } from "./values.mjs";

export function questionChoices(options = {}) {
  if (options.choices === undefined) return {};
  if (
    !Array.isArray(options.choices) ||
    options.choices.length < 1 ||
    options.choices.length > 6
  )
    throw new Error("A choice question needs 1..6 options");
  const choices = options.choices.map((c) => ({
    label: requireText(c.label, "choice label", 80),
    value: requireText(c.value ?? c.label, "choice value", 200),
    ...(c.description === undefined
      ? {}
      : { description: requireText(c.description, "choice description", 200) }),
  }));
  if (new Set(choices.map((c) => c.value)).size !== choices.length)
    throw new Error("Duplicate choice value");
  if (
    options.allowCustom !== undefined &&
    typeof options.allowCustom !== "boolean"
  )
    throw new Error("Invalid allowCustom");
  return { choices, allowCustom: options.allowCustom === true };
}

/** A user-visible envelope, never a Work completion or an authority grant. */
export function userMessage(raw, interactive = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid user message");
  const allowed = [
    "type",
    "content",
    "attachments",
    "attachmentId",
    "alt",
    "replyTo",
    "channel",
    "interactionId",
  ];
  if (Object.keys(raw).some((k) => !allowed.includes(k)))
    throw new Error("Unknown user message field");
  const types = interactive
    ? [
        "text",
        "attachment",
        "question",
        "secret-request",
        "authorization-request",
        "handoff",
      ]
    : ["text", "attachment"];
  if (!types.includes(raw.type))
    throw new Error("Unsupported user message type");
  if (raw.channel !== undefined && raw.channel !== "local:main")
    throw new Error("User destination is not configured");
  const value = { type: raw.type, channel: "local:main" };
  if (raw.replyTo !== undefined)
    value.replyTo = requireText(raw.replyTo, "replyTo", 160);
  if (raw.type === "text")
    value.content = requireText(raw.content, "message content", 1000000);
  else if (raw.content !== undefined)
    throw new Error("Only text messages accept content");
  if (raw.type === "attachment" && raw.attachments !== undefined)
    throw new Error("Attachment messages use attachmentId");
  const attachments =
    raw.type === "attachment"
      ? [{ attachmentId: raw.attachmentId, alt: raw.alt }]
      : (raw.attachments ?? []);
  if (!Array.isArray(attachments) || attachments.length > 8)
    throw new Error("At most 8 attachments per message");
  if (raw.type !== "text" && raw.type !== "attachment" && attachments.length)
    throw new Error("Interactive messages cannot carry attachments");
  if (attachments.length) {
    const refs = attachments.map((a) => {
      if (
        !a ||
        Object.keys(a).some((k) => !["attachmentId", "alt"].includes(k)) ||
        !/^[a-f0-9]{64}$/.test(a.attachmentId)
      )
        throw new Error("Invalid attachment reference");
      return {
        attachmentId: a.attachmentId,
        ...(a.alt === undefined
          ? {}
          : { alt: requireText(a.alt, "attachment alt", 300) }),
      };
    });
    if (raw.type === "attachment") {
      value.attachmentId = refs[0].attachmentId;
      if (refs[0].alt) value.alt = refs[0].alt;
    } else value.attachments = refs;
  }
  if (
    ["question", "secret-request", "authorization-request", "handoff"].includes(
      raw.type,
    )
  )
    value.interactionId = requireText(raw.interactionId, "interactionId", 160);
  else if (raw.interactionId !== undefined)
    throw new Error("Only interactive messages take interactionId");
  if (
    raw.type === "text" &&
    (raw.attachmentId !== undefined || raw.alt !== undefined)
  )
    throw new Error("Use attachments on a text message");
  return value;
}
