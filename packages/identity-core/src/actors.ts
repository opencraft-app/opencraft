/** Stable identity, independent of its current login, Hub endpoint or engine process. */
export type ActorKind = 'human' | 'session';
export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly generation: number;
  readonly createdAt: number;
  /** Provenance only: confers no management or resource permission. */
  readonly createdBy: string | null;
}
/** Trusted server context. Never deserialize this from a client frame or request body. */
export interface ActorContext {
  readonly actorId: string;
  readonly generation: number;
  readonly credentialId: string | null;
  readonly expiresAt: number;
}
