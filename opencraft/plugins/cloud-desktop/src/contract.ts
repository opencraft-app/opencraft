/** Canonical identity from the conversation binding + authorized environment directory.
 * Never inferred from a renderer route or a legacy Host label. */
export interface DesktopTarget {
  readonly conversationId: string;
  readonly serverId: string;
  readonly environmentId: string;
  readonly principalId: string;
}

/** The backend is the authorization and exclusive-input authority. */
export interface DesktopControlLease {
  /** Subscribe before binding input. Revocation must synchronously disable input. */
  subscribeRevoked(listener: () => void): () => void;
  isValid(): boolean;
  /** Idempotent; release this control grant, never stop the resource. */
  release(): void;
}

export type DesktopFailureReason = "timeout" | "identity" | "authorization" | "transport" | "media" | "unknown";

/** Fixed safe classification only. Never infer this from arbitrary error text. */
export class DesktopFailure extends Error {
  constructor(readonly reason: DesktopFailureReason) { super("Desktop operation failed"); }
}

export interface DesktopConnectionSnapshot {
  /** Decoded media geometry, not a requested remote desktop resize. */
  readonly mediaAspectRatio?: number;
  readonly videoReady: boolean;
  readonly inputReady: boolean;
  readonly controlAvailable: boolean;
  readonly ended: boolean;
  /** Only an established stream's classified transport loss is retryable.
   * Missing means manual recovery; never infer this from raw error text. */
  readonly retryable?: boolean;
  readonly failure?: DesktopFailureReason;
}

/** A transient viewing connection; credentials remain private to the adapter. */
export interface DesktopFramePreview {
  /** Bounded in-memory JPEG, never a remote URL or interactive surface. */
  readonly dataUrl: string;
  readonly aspectRatio: number;
}
export interface DesktopConnection {
  getSnapshot(): DesktopConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  requestControl(signal: AbortSignal): Promise<DesktopControlLease>;
  /** Optional synchronous capture of the last actually decoded frame. */
  capturePreview?(): DesktopFramePreview | null;
  /** Closes local transport; does not stop the desktop/Agent. */
  close(): void;
}

export interface DesktopAttachment {
  readonly target: DesktopTarget;
  readonly resourceId: string;
  /** Physical instance generation; not a stable tab ID. */
  readonly incarnation: string;
  connect(signal: AbortSignal): Promise<DesktopConnection>;
  /** Idempotent short-lived viewer lease release, not remote teardown. */
  release(): void;
}

export interface DesktopBackend {
  /** Explicit opt-in: prepare only allocates a fresh, reauthorized viewer and
   * can be repeated without replaying resource creation or Agent execution. */
  readonly recoverTransport?: boolean;
  /** Cached, authorized capability lookup. Null means no entry, not an implicit
   * local-machine fallback. Resolution must be for this exact conversation. */
  resolveTarget(conversationId: string): DesktopTarget | null;
  /** Emit for binding, principal, permission or capability changes. */
  subscribe(listener: () => void): () => void;
  /** Recheck authorization and target incarnation on the server. Honor abort;
   * if completion races cancellation, the consumer will release the result. */
  prepare(target: DesktopTarget, signal: AbortSignal): Promise<DesktopAttachment>;
}

export function desktopTargetKey(target: DesktopTarget): string {
  return JSON.stringify([target.conversationId, target.serverId, target.environmentId, target.principalId]);
}
