import type { AppServerConnection } from "./appserver.ts";
import type {
  TransparentTurnCredential,
  TransparentTurnProvider,
} from "./transparent-turn-execution.ts";

export interface CodexCredentialIdentity {
  accountIdentity: string;
  authMode: string;
  userId: string;
  username: string;
  installationId: string | null;
  credentialRef: string | null;
  providerId: string | null;
}

export interface CredentialPort {
  attachCodexFallbackSource(source: {
    ensureActiveForUser(userId: string | null | undefined): unknown;
  }): () => void;
  resolve(connection: AppServerConnection): TransparentTurnCredential | null;
  resolveUser(userId: string): {
    accountIdentity?: string | null;
    providerId?: string | null;
  } | null;
  resolveCodexUser(userId: string | undefined): CodexCredentialIdentity | null;
  resolveProvider(
    userId: string | undefined,
    provider: TransparentTurnProvider,
  ): TransparentTurnCredential | null;
}
