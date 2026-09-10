import type { LightVelaAccountPort } from "@opencraft/plugin-lightvela-hermes/transport";

export type MobileLightVelaPhase = "loading" | "anonymous" | "authenticated" | "error";

export interface MobileLightVelaSnapshot {
  readonly revision: number;
  readonly phase: MobileLightVelaPhase;
  readonly activeBotId: string | null;
  readonly botName: string | null;
  readonly error: string | null;
}

export interface MobileLightVelaAccount extends LightVelaAccountPort {
  getSnapshot(): MobileLightVelaSnapshot;
  initialize(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  retry(): Promise<void>;
  dispose(): void;
}
