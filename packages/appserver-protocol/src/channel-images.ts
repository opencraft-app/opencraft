export const CHANNEL_IMAGE_LIMIT = 2 * 1024 * 1024;
export const CHANNEL_IMAGE_TYPES = ['image/png', 'image/jpeg'] as const;
export type ChannelImageType = typeof CHANNEL_IMAGE_TYPES[number];
export type ChannelImage = { readonly type: ChannelImageType; readonly bytes: Uint8Array };

export function channelImageType(bytes: Uint8Array): ChannelImageType | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length > CHANNEL_IMAGE_LIMIT) return;
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
}
