export function supportsH264MediaSource() {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E028"');
}
