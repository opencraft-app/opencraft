/** Unknown/provider-only formats never claim browser playback support. */
export function channelMediaKind(name: string, type = ""): "audio" | "video" | null {
  if (/\.(amr|silk|speex)$/iu.test(name) || /(?:amr|silk|speex)/iu.test(type)) return null;
  if (/^audio\//iu.test(type) || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/iu.test(name)) return "audio";
  if (/^video\//iu.test(type) || /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/iu.test(name)) return "video";
  return null;
}
