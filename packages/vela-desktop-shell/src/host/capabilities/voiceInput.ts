export type VoiceInputPermissionState = "granted" | "denied" | "prompt";
export type VoiceInputState = "idle" | "requesting-permission" | "listening" | "stopping" | "error";

export interface VoiceInputOptions {
  language?: string;
  interimResults?: boolean;
}

export interface VoiceInputError {
  code: string;
  message: string;
}

export type RuntimeHostUnsubscribe = () => void;

export interface VoiceInputHost {
  isAvailable(): Promise<boolean> | boolean;
  requestPermission(): Promise<VoiceInputPermissionState>;
  start(options?: VoiceInputOptions): Promise<void> | void;
  stop(): Promise<void> | void;
  onPartialTranscript(listener: (text: string) => void): RuntimeHostUnsubscribe;
  onFinalTranscript(listener: (text: string) => void): RuntimeHostUnsubscribe;
  onStateChange(listener: (state: VoiceInputState) => void): RuntimeHostUnsubscribe;
  onError(listener: (error: VoiceInputError) => void): RuntimeHostUnsubscribe;
}
