/** Channel attachment bytes stay behind channel membership authorization. */
export const CHANNEL_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export interface ChannelAttachment {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}
export function validChannelAttachment(value: ChannelAttachment): boolean {
  return (
    !!value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 160 &&
    !/[\x00-\x1f\x7f/\\]/u.test(value.name) &&
    value.name !== "." &&
    value.name !== ".." &&
    typeof value.type === "string" &&
    /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.type) &&
    value.bytes instanceof Uint8Array &&
    value.bytes.length <= CHANNEL_ATTACHMENT_LIMIT
  );
}
