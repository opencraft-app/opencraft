const { ipcRenderer } = require('electron');
(async () => {
  const config = { codec: 'avc1.42E028', width: 1280, height: 720, bitrate: 2500000, framerate: 30,
    hardwareAcceleration: 'prefer-software', latencyMode: 'realtime', contentHint: 'text', avc: { format: 'annexb' } };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('Software H.264 unsupported');
  const encoders = new Map();
  const release = (id, expected = encoders.get(id)) => {
    if (!expected || encoders.get(id) !== expected) return false;
    encoders.delete(id); try { expected.encoder.close(); } catch {} return true;
  };
  ipcRenderer.on('release-encoder', (_event, id) => release(id));
  ipcRenderer.on('encode-frame', (_event, { id, page, bucket, epoch, width, height, bytes, timestamp, key, fps = 30, bitrate = 2500000 }) => {
    let entry = encoders.get(id);
    const signature = fps + ':' + bitrate;
    try {
      if (entry && (entry.epoch !== epoch || entry.signature !== signature)) { release(id, entry); entry = undefined; }
      if (!entry) {
        const owned = entry = { epoch, signature };
        owned.encoder = new VideoEncoder({ output: chunk => {
          if (encoders.get(id) !== owned) return;
          const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
          ipcRenderer.send('encoded-packet', { id, page, bucket, epoch, bytes, key: chunk.type === 'key', timestamp: chunk.timestamp }); },
          error: () => { if (release(id, owned)) ipcRenderer.send('encoder-error', { id, page, bucket, epoch }); } });
        encoders.set(id, owned);
        owned.encoder.configure({ ...config, width, height, framerate: fps, bitrate: Math.max(250000, Math.min(5000000, Math.round(bitrate * width * height / (1280 * 720)))) });
      }
      const frame = new VideoFrame(bytes, { format: 'BGRA', codedWidth: width, codedHeight: height, timestamp, transfer: [bytes.buffer] });
      try { entry.encoder.encode(frame, { keyFrame: key }); } finally { frame.close(); }
    } catch { if (release(id, entry) || !encoders.has(id)) ipcRenderer.send('encoder-error', { id, page, bucket, epoch }); }
  });
  ipcRenderer.send('encoder-ready');
})().catch(() => ipcRenderer.send('encoder-error'));
