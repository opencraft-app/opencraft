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
  readonly loginPending: boolean;
  readonly botCount: number;
  readonly activeBotId: string | null;
  readonly botName: string | null;
  readonly error: string | null;
}

export interface MobileAuthenticatedSession {
  readonly region: LightVelaRegion;
  readonly token: string;
  readonly credentialScope: string;
}

export interface MobileLightVelaAccount extends LightVelaAccountPort {
  getSnapshot(): MobileLightVelaSnapshot;
  getAuthenticatedSession(): MobileAuthenticatedSession | null;
  initialize(): Promise<void>;
  selectRegion(region: LightVelaRegion): Promise<void>;
  signIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  retry(): Promise<void>;
  webSessionToken(): Promise<string | null>;
  dispose(): void;
}
