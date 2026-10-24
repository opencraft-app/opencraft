/** Small fragmented-MP4 envelope for Annex-B H.264. Encoding stays on Server;
 * MediaSource lets HTTP/Safari clients use the browser's native video decoder. */
const bytes = (...values: number[]) => new Uint8Array(values);
const concat = (...parts: Uint8Array[]) => { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { result.set(p, at); at += p.length; } return result; };
const u32 = (...values: number[]) => { const result = new Uint8Array(values.length * 4); const view = new DataView(result.buffer); values.forEach((value, i) => view.setUint32(i * 4, value)); return result; };
const text = (value: string) => new TextEncoder().encode(value);
const box = (type: string, ...parts: Uint8Array[]) => { const payload = concat(...parts); return concat(u32(payload.length + 8), text(type), payload); };
const full = (type: string, version: number, flags: number, ...parts: Uint8Array[]) => box(type, bytes(version, flags >> 16, flags >> 8, flags), ...parts);
const matrix = u32(0x10000,0,0,0,0x10000,0,0,0,0x40000000);
function nals(data: Uint8Array) {
  const starts: { at: number; size: number }[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (size) { starts.push({ at: i, size }); i += size - 1; }
  }
  return starts.map((start, i) => data.subarray(start.at + start.size, starts[i + 1]?.at ?? data.length));
}
function init(sps: Uint8Array, pps: Uint8Array, width: number, height: number) {
  const avcc = box('avcC', bytes(1,sps[1]!,sps[2]!,sps[3]!,255,225,sps.length >> 8,sps.length),sps,bytes(1,pps.length >> 8,pps.length),pps);
  const avc1 = box('avc1', new Uint8Array(6), bytes(0,1), new Uint8Array(16), bytes(width >> 8,width,height >> 8,height), u32(0x480000,0x480000,0), bytes(0,1), new Uint8Array(32), bytes(0,24,255,255), avcc);
  const stbl = box('stbl', full('stsd',0,0,u32(1),avc1), ...['stts','stsc','stco'].map(type => full(type,0,0,u32(0))), full('stsz',0,0,u32(0,0)));
  const dinf = box('dinf', full('dref',0,0,u32(1),full('url ',0,1)));
  const minf = box('minf',full('vmhd',0,1,new Uint8Array(8)),dinf,stbl);
  const mdia = box('mdia',full('mdhd',0,0,u32(0,0,90000,0),bytes(0x55,0xc4,0,0)),full('hdlr',0,0,u32(0),text('vide'),new Uint8Array(12),text('Video\0')),minf);
  const trak = box('trak',full('tkhd',0,7,u32(0,0,1,0,0),new Uint8Array(8),new Uint8Array(8),matrix,u32(width << 16,height << 16)),mdia);
  const mvhd = full('mvhd',0,0,u32(0,0,90000,0,0x10000),bytes(1,0,0,0),new Uint8Array(8),matrix,new Uint8Array(24),u32(2));
  return concat(box('ftyp',text('isom'),u32(512),text('isomiso6avc1mp41')),box('moov',mvhd,trak,box('mvex',full('trex',0,0,u32(1,1,3000,0,0)))));
}
function fragment(sequence: number, time: number, sample: Uint8Array, key: boolean) {
  const make = (offset: number) => box('moof',full('mfhd',0,0,u32(sequence)),box('traf',full('tfhd',0,0x020000,u32(1)),full('tfdt',1,0,u32(0,time)),full('trun',0,0x000701,u32(1,offset,3000,sample.length,key ? 0x02000000 : 0x01010000))));
  const moof = make(0); return concat(make(moof.length + 8),box('mdat',sample));
}
export function supportsH264MediaSource() {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E028"');
}
/** A one-shot presentation fence; cancellation also retires queued callbacks. */
export function onFirstVideoFrame(video: HTMLVideoElement, present: () => void): () => void {
  let retired = false, frame: number | null = null, raf: number | null = null;
  const events = ['loadeddata', 'seeked', 'playing'];
  const cancel = () => {
    if (retired) return;
    retired = true;
    if (frame !== null) video.cancelVideoFrameCallback(frame);
    if (raf !== null) cancelAnimationFrame(raf);
    frame = raf = null;
    for (const event of events) video.removeEventListener(event, signal);
  };
  const ready = () => { if (!retired && video.readyState >= 2) { cancel(); present(); } };
  const signal = () => {
    if (retired || raf !== null) return;
    raf = requestAnimationFrame(() => { raf = null; if (!video.seeking) ready(); });
  };
  if (typeof video.requestVideoFrameCallback === 'function') {
    const awaitFrame = () => { frame = video.requestVideoFrameCallback(() => {
      frame = null; if (retired) return;
      if (video.readyState >= 2) ready(); else awaitFrame();
    }); };
    awaitFrame();
  } else {
    for (const event of events) video.addEventListener(event, signal);
    signal();
  }
  return cancel;
}

export class H264MediaSource {
  private source = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private sequence = 0;
  private disposed = false;
  private url: string;
  private primed = false;
  private lastKey = 0;
  private needsKey = false;
  constructor(private video: HTMLVideoElement, private width: number, private height: number, private recover: () => void, private requestKey: () => void) {
    video.muted = true; video.autoplay = true; video.playsInline = true;
    this.url = URL.createObjectURL(this.source); video.src = this.url;
    this.source.addEventListener('sourceopen', () => { if (this.disposed) return;
      try { this.buffer = this.source.addSourceBuffer('video/mp4; codecs="avc1.42E028"'); this.buffer.addEventListener('updateend', () => this.updated()); this.buffer.addEventListener('error', recover); this.pump(); }
      catch { recover(); }
    }, { once: true });
    video.addEventListener('waiting', this.waiting);
    video.addEventListener('error', recover);
  }
  private waiting = () => this.catchUp();
  private catchUp() {
    if (this.disposed || !this.buffer?.buffered.length) return;
    const end = this.buffer.buffered.end(this.buffer.buffered.length - 1);
    // On sparse/VFR updates MSE may wait for additional future samples. A seek
    // to the last complete sample presents the update without periodic frames.
    if (this.video.readyState < 3 || end - this.video.currentTime > .2 || !this.primed) {
      this.primed = true; this.video.currentTime = Math.max(this.buffer.buffered.start(0), end - .025);
    }
    void this.video.play().catch(() => {});
  }
  private updated() {
    if (this.disposed) return;
    this.catchUp();
    if (this.buffer && !this.buffer.updating && this.lastKey > 0 && this.buffer.buffered.length && this.video.currentTime >= this.lastKey && this.buffer.buffered.start(0) < this.lastKey - .01) {
      this.buffer.remove(0, this.lastKey); return;
    }
    this.pump();
  }
  private pump() {
    if (!this.buffer || this.buffer.updating || this.disposed || !this.queue.length) return;
    const next = this.queue.shift()!;
    try { this.buffer.appendBuffer(next as Uint8Array<ArrayBuffer>); } catch { this.recover(); }
  }
  push(packet: ArrayBuffer) {
    if (this.disposed || packet.byteLength < 10) return;
    const data = new Uint8Array(packet), key = data[0] === 1, units = nals(data.subarray(9));
    for (const unit of units) { if ((unit[0]! & 31) === 7) this.sps = unit.slice(); if ((unit[0]! & 31) === 8) this.pps = unit.slice(); }
    if (!this.sequence) { if (!key || !this.sps || !this.pps) return; this.queue.push(init(this.sps, this.pps, this.width, this.height)); }
    const samples = units.filter(unit => ![7,8,9].includes(unit[0]! & 31));
    const sample = concat(...samples.flatMap(unit => [u32(unit.length), unit]));
    // A virtual contiguous 30Hz timeline avoids long empty media ranges when
    // capture pauses. Sparse updates still display immediately via catchUp.
    const time = this.sequence / 30;
    if (key) { this.lastKey = time; this.needsKey = false; }
    if (time - this.lastKey >= 10 && !this.needsKey) { this.needsKey = true; this.requestKey(); }
    this.queue.push(fragment(++this.sequence, (this.sequence - 1) * 3000, sample, key));
    if (this.queue.length > 8) { this.recover(); return; }
    this.pump();
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.queue = [];
    this.video.removeEventListener('waiting', this.waiting); this.video.removeEventListener('error', this.recover);
    this.video.pause(); this.video.removeAttribute('src'); this.video.load(); URL.revokeObjectURL(this.url);
  }
}
