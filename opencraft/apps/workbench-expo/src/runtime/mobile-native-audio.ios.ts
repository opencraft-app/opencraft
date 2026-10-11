import { AudioModule, AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { File } from "expo-file-system";
import type { NativeAudioEvent, NativeAudioRequest } from "@opencraft/mobile-bot-bridge";
import { mobileDeveloperLog } from "./mobile-developer-log";

let activeDeviceOwner: object | null = null;

/** Single device owner; cancellation fences permission, prepare, stop and file delivery. */
export class MobileNativeAudio {
  private owner: { id: string; cancelled: boolean; ending: boolean; recorder: InstanceType<typeof AudioModule.AudioRecorder> | null; ready: Promise<void>; releasing?: Promise<void>; meter?: ReturnType<typeof setInterval>; limit?: ReturnType<typeof setTimeout> } | null = null;
  constructor(private readonly emit: (event: NativeAudioEvent) => void) {}
  handle(request: NativeAudioRequest) {
    if (request.action === "start") {
      if (this.owner || activeDeviceOwner) { this.emit({ type: "native-audio-event", id: request.id, event: "error", reason: "capture" }); return; }
      const owner: NonNullable<MobileNativeAudio["owner"]> = { id: request.id, cancelled: false, ending: false, recorder: null, ready: Promise.resolve() };
      this.owner = owner; activeDeviceOwner = owner;
      owner.ready = this.start(owner);
      void owner.ready.catch(async () => { if (!owner.cancelled) this.error(owner, "capture"); await this.release(owner); });
    } else {
      const owner = this.owner;
      if (!owner || owner.id !== request.id) return;
      if (request.action === "cancel") this.cancel();
      else if (!owner.ending) { owner.ending = true; void this.finish(owner); }
    }
  }
  private current(owner: NonNullable<MobileNativeAudio["owner"]>) { return this.owner === owner && !owner.cancelled; }
  private error(owner: NonNullable<MobileNativeAudio["owner"]>, reason: "permission" | "capture" | "cancelled") {
    this.emit({ type: "native-audio-event", id: owner.id, event: "error", reason });
    mobileDeveloperLog.log("speech.capture.failed"); owner.cancelled = true;
  }
  private async start(owner: NonNullable<MobileNativeAudio["owner"]>) {
    const permission = await requestRecordingPermissionsAsync();
    if (!this.current(owner)) return;
    if (!permission.granted) { this.error(owner, "permission"); throw new Error("permission"); }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
    if (!this.current(owner)) return;
    const ios = { extension: ".wav", outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.HIGH, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false };
    // AudioModule's constructor consumes flattened platform options, as Expo's hook does.
    const recorder = new AudioModule.AudioRecorder({ sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, isMeteringEnabled: true, ...ios, ios });
    owner.recorder = recorder;
    await recorder.prepareToRecordAsync();
    if (!this.current(owner)) return;
    recorder.record();
    mobileDeveloperLog.log("speech.capture.started");
    this.emit({ type: "native-audio-event", id: owner.id, event: "ready" });
    owner.limit = setTimeout(() => { this.error(owner, "capture"); this.cancel(); }, 120000);
    owner.meter = setInterval(() => {
      if (!this.current(owner) || owner.ending) return;
      const status = recorder.getStatus();
      if (!status.isRecording || status.mediaServicesDidReset) { this.error(owner, "capture"); this.cancel(); return; }
      this.emit({ type: "native-audio-event", id: owner.id, event: "level", level: Math.min(1, Math.max(0, 10 ** ((status.metering ?? -160) / 20) * 4)) });
    }, 100);
  }
  private async finish(owner: NonNullable<MobileNativeAudio["owner"]>) {
    try {
      await owner.ready;
      if (!this.current(owner) || !owner.recorder) return;
      clearInterval(owner.meter); clearTimeout(owner.limit);
      await owner.recorder.stop();
      if (!this.current(owner)) return;
      const uri = owner.recorder.uri;
      if (!uri) throw new Error("No recording");
      const file = new File(uri);
      if (file.size < 44 || file.size > 8 * 1024 * 1024) throw new Error("Recording limit");
      const data = await file.base64();
      let count = 0;
      for (let offset = 0; offset < data.length; offset += 65536) {
        if (!this.current(owner)) return;
        this.emit({ type: "native-audio-event", id: owner.id, event: "chunk", index: count++, base64: data.slice(offset, offset + 65536) });
        // Bound each bridge frame; yield so cancellation can retire remaining audio.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (this.current(owner)) this.emit({ type: "native-audio-event", id: owner.id, event: "complete", chunks: count });
    } catch { if (this.current(owner)) this.error(owner, "capture"); }
    finally { await this.release(owner); }
  }
  cancel() {
    const owner = this.owner;
    if (!owner) return;
    if (!owner.cancelled) this.error(owner, "cancelled");
    owner.cancelled = true; clearInterval(owner.meter); clearTimeout(owner.limit);
    // Do not allow a new owner to race an outstanding permission/prepare operation.
    void owner.ready.catch(() => undefined).then(() => this.release(owner));
  }
  private release(owner: NonNullable<MobileNativeAudio["owner"]>): Promise<void> {
    return owner.releasing ??= this.releaseDevice(owner);
  }
  private async releaseDevice(owner: NonNullable<MobileNativeAudio["owner"]>) {
    clearInterval(owner.meter); clearTimeout(owner.limit);
    const recorder = owner.recorder; owner.recorder = null;
    if (recorder) {
      try { if (recorder.isRecording) await recorder.stop(); } catch { /* Device already interrupted. */ }
      const uri = recorder.uri;
      try { recorder.release(); } catch { mobileDeveloperLog.log("speech.capture.cleanup.failed"); }
      if (uri) { try { const file = new File(uri); if (file.exists) file.delete(); } catch { mobileDeveloperLog.log("speech.capture.cleanup.failed"); } }
    }
    if (this.owner === owner) {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      if (this.owner === owner) this.owner = null;
      if (activeDeviceOwner === owner) activeDeviceOwner = null;
    }
  }
}
