import { HermesReplayCheckpoint } from "./rpc-transport";
import type { HermesTurnEventStateMachine } from "./turn-event-state-machine";
import type { HermesTranscriptWindowSnapshot } from "./transcript-window";

/** Connection-local replica, never durable history. A watermark travels only
 * with the projection that consumed it. Account/epoch changes retire both. */
export class HermesProjectionRecovery extends HermesReplayCheckpoint {
  readonly owners = new Map<string, HermesTurnEventStateMachine>();
  readonly pending = new Map<string, HermesTurnEventStateMachine[]>();
  readonly queuedBoundaries = new Set<string>();
  /** Read cache only. Unlike owners/watermarks, this never grants replay or
   * execution authority. Its lifetime is the owning account connection. */
  readonly transcriptWindows = new Map<string, HermesTranscriptWindowSnapshot>();

  override reset(): void {
    super.reset();
    this.owners.clear();
    this.pending.clear();
    this.queuedBoundaries.clear();
    this.transcriptWindows.clear();
  }

  prepareReconnect(): void {
    for (const sessionId of this.owners.keys()) {
      if (!this.lastSeenSeq.has(sessionId)) {
        this.owners.delete(sessionId);
        this.pending.delete(sessionId);
        this.queuedBoundaries.delete(sessionId);
      }
    }
    for (const sessionId of this.lastSeenSeq.keys()) {
      if (!this.owners.has(sessionId)) this.lastSeenSeq.delete(sessionId);
    }
  }
}
