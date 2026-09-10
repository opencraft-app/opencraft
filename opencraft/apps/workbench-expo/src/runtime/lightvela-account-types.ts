import type { LightVelaAccountPort } from "@opencraft/plugin-lightvela-hermes/transport";
import type {
  LightVelaAccountPhase,
  LightVelaRegion,
} from "@opencraft/plugin-lightvela-hermes/account-contract";

export type MobileLightVelaPhase = LightVelaAccountPhase;

export interface MobileLightVelaSnapshot {
  readonly revision: number;
  readonly region: LightVelaRegion;
  readonly phase: MobileLightVelaPhase;
  readonly botCount: number;
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
