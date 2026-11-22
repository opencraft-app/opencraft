import type { ChannelGroupCreateOption } from "@opencraft/appserver-protocol";
const OPTION_ID = /^[a-z][a-z0-9-]{0,31}$/,
  MESSAGE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
function messageDescriptor(value: unknown) {
  const descriptor = value as { id?: unknown; defaultMessage?: unknown } | null;
  return !!descriptor &&
    typeof descriptor === "object" &&
    typeof descriptor.id === "string" &&
    MESSAGE_ID.test(descriptor.id) &&
    typeof descriptor.defaultMessage === "string" &&
    descriptor.defaultMessage.length > 0 &&
    descriptor.defaultMessage.length <= 512
    ? { id: descriptor.id, defaultMessage: descriptor.defaultMessage }
    : undefined;
}
/** Installation-declared group creation choices from the capabilities response.
 * Malformed or duplicate entries are dropped; the server validates submissions again. */
export function parseGroupCreateOptions(value: unknown): ChannelGroupCreateOption[] {
  if (!Array.isArray(value)) return [];
  const options: ChannelGroupCreateOption[] = [];
  for (const item of value.slice(0, 8)) {
    const id = item?.id,
      label = messageDescriptor(item?.label),
      description = item?.description === undefined ? undefined : messageDescriptor(item.description);
    if (
      typeof id !== "string" ||
      !OPTION_ID.test(id) ||
      !label ||
      (item.description !== undefined && !description) ||
      typeof item.defaultSelected !== "boolean" ||
      options.some((option) => option.id === id)
    )
      continue;
    options.push({ id, label, ...(description ? { description } : {}), defaultSelected: item.defaultSelected });
  }
  return options;
}
