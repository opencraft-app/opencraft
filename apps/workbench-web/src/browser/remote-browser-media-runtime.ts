import { H264MediaSource, onFirstVideoFrame } from './h264-media-source';
import type { RemoteBrowserMediaPage as Page } from './remote-browser-surface-host';
export { WebSocketMediaReceiver } from '@opencraft/remote-interaction/websocket';

/** The Page owns decoder/frame resources; code preparation owns no resources. */
export interface RemoteBrowserMediaOwner {
  paintFrame(p: Page, frame: CanvasImageSource, width: number, height: number, frameId?: string): void;
  didPaint(p: Page): void;
  resetDecoder(p: Page, preserveFrame?: boolean): void;
  run(p: Page, method: string, input?: unknown): void;
}
export function snapshotVideo(host: RemoteBrowserMediaOwner, p: Page, video: HTMLVideoElement) {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    // A temporary snapshot protects the existing cover if the video cannot be
    // read. No per-frame video copying, retained second decoder or idle loop.
    const frame = document.createElement('canvas');
    frame.width = video.videoWidth; frame.height = video.videoHeight;
    try {
      const context = frame.getContext('2d', { alpha: false }); if (!context) return;
      context.drawImage(video, 0, 0);
      host.paintFrame(p, frame, frame.width, frame.height);
    } catch { /* Keep the previous readable cover. */ }
    finally { frame.width = frame.height = 0; }
  }

export function decodeFrame(host: RemoteBrowserMediaOwner, p: Page, bytes: ArrayBuffer) {
    if (bytes.byteLength < 10) return;
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
      if (!p.media) {
        const video = document.createElement('video');
        Object.assign(video.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: 'auto', aspectRatio: `${p.width} / ${p.height}`, opacity: '0', zIndex: '1', pointerEvents: 'none' });
        p.canvas.style.position = 'relative'; p.container.prepend(video); p.video = video;
        p.cancelVideoReady = onFirstVideoFrame(video, () => {
          if (p.closed || p.video !== video) return;
          snapshotVideo(host, p, video); video.style.opacity = '1'; host.didPaint(p); p.cancelVideoReady = null;
        });
        p.media = new H264MediaSource(video, p.width, p.height, () => {
          if (p.closed || p.video !== video) return;
          host.resetDecoder(p, true); host.run(p, 'keyframe');
        }, () => { if (!p.closed && p.video === video) host.run(p, 'keyframe'); });
      }
      p.media.push(bytes);
    } else {
      const data = new Uint8Array(bytes), key = data[0] === 1;
      const recover = () => { host.resetDecoder(p, true); host.run(p, 'keyframe'); };
      p.mediaReceiver?.observeQueue(p.decoder?.decodeQueueSize ?? 0);
      if (p.decoder && p.decoder.decodeQueueSize > 2) { recover(); return; }
      if (p.needsKey && !key) return;
      if (!p.decoder) {
        const decoder = new VideoDecoder({ output: frame => {
          if (p.closed || p.decoder !== decoder) { frame.close(); return; }
          p.mediaReceiver?.decoded(String(frame.timestamp), decoder.decodeQueueSize);
          p.latest?.close(); p.latest = frame;
          if (!p.raf) p.raf = requestAnimationFrame(() => { p.raf = 0; const latest = p.latest; p.latest = null;
            if (latest) { host.paintFrame(p, latest, p.width, p.height, String(latest.timestamp)); latest.close(); } });
        }, error: () => { if (p.decoder === decoder) recover(); } });
        p.decoder = decoder;
        p.decoder.configure({ codec: 'avc1.42E028', optimizeForLatency: true });
      }
      p.needsKey = false;
      try { p.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Number(new DataView(bytes).getBigUint64(1)), data: data.subarray(9) })); }
      catch { recover(); }
    }
  }
