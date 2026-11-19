import { stable } from "./values.mjs";

export function resourceId(value, label = "resource ID") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function opaqueIdentity(value, label = "identity") {
  if (typeof value !== "string" || !value || value.length > 256 || /[\x00-\x20]/u.test(value))
    throw Error("Invalid " + label);
  return value;
}
/** Platform supplies this immutable binding after authorization. A file is not a grant. */
export function botBinding(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["serverId", "botId", "assignmentId", "owner"].includes(k))
  )
    throw new Error("Invalid Bot binding");
  if (
    !value.owner ||
    !["human", "project"].includes(value.owner.kind) ||
    Object.keys(value.owner).some((k) => !["kind", "id"].includes(k))
  )
    throw new Error("Invalid Bot owner binding");
  return Object.freeze({
    serverId: opaqueIdentity(value.serverId, "Server ID"),
    botId: resourceId(value.botId, "Bot ID"),
    assignmentId: resourceId(value.assignmentId, "assignment ID"),
    owner: Object.freeze({
      kind: value.owner.kind,
      id: opaqueIdentity(value.owner.id, "owner ID"),
    }),
  });
}
export function assertBotBinding(actual, expected) {
  if (stable(botBinding(actual)) !== stable(botBinding(expected)))
    throw new Error("Bot binding changed; explicit reassignment required");
}
