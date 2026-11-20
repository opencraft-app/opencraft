/** A local presentation lease, not a resource or navigation store. */
export interface SceneTarget {
  readonly ownerId: string;
  readonly key: string;
  readonly foreground: 'primary' | 'tools';
}

export interface SceneTransition extends SceneTarget {
  readonly id: symbol;
  readonly signal: AbortSignal;
  readonly ready: Promise<void>;
  layoutReady(): void;
  /** The allocated home may change without a window/card-slot resize. */
  subscribeLayout(listener: () => void): () => void;
  contentReady(): void;
  unavailable(): void;
  /** Selection and physical handback execute under the same validity check. */
  commit(handoff: () => void): boolean;
  cancel(): void;
}

/** Only one lease can change the Shell allocation. Retiring visual flights may
 * continue, but no longer own a target, readiness receipt or selection commit. */
export class SceneTransitionOwner {
  private current: SceneTransition | null = null;
  private intent = Symbol('scene-intent');
  constructor(private readonly changed: (scene: SceneTransition | null) => void) {}

  cancel() { this.intent = Symbol('scene-cancel'); this.current?.cancel(); }

  begin(target: SceneTarget, parent: AbortSignal, ownerIsCurrent: () => boolean): SceneTransition {
    const controller = new AbortController();
    let phase: 'preparing' | 'ready' | 'committing' | 'committed' | 'cancelled' = 'preparing';
    let layout = false, content = false;
    const layoutListeners = new Set<() => void>();
    let resolve!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Cancellation may happen during synchronous React preparation, before the
    // motion consumer has had a chance to attach its rejection handler.
    void ready.catch(() => undefined);
    const release = () => {
      parent.removeEventListener('abort', cancel);
      layoutListeners.clear();
      if (this.current === scene) { this.current = null; this.changed(null); }
    };
    const cancel = () => {
      if (phase === 'cancelled' || phase === 'committed' || phase === 'committing') return;
      phase = 'cancelled';
      reject(new Error('Scene transition retired'));
      release();
      controller.abort();
    };
    const acknowledge = () => {
      if (phase !== 'preparing') return;
      if (!ownerIsCurrent()) { cancel(); return; }
      if (layout && content) { phase = 'ready'; resolve(); }
    };
    const scene: SceneTransition = {
      ...target, id: Symbol('scene-transition'), signal: controller.signal, ready,
      layoutReady() {
        if (phase !== 'preparing' && phase !== 'ready') return;
        if (!ownerIsCurrent()) { cancel(); return; }
        layout = true; acknowledge();
        for (const listener of layoutListeners) listener();
      },
      subscribeLayout(listener) {
        if (phase !== 'preparing' && phase !== 'ready') return () => {};
        layoutListeners.add(listener); return () => { layoutListeners.delete(listener); };
      },
      contentReady() { content = true; acknowledge(); },
      unavailable: cancel, cancel,
      commit: handoff => {
        if (phase !== 'ready' || this.current !== scene || !ownerIsCurrent()) { cancel(); return false; }
        phase = 'committing';
        // clean()/modal unmount may abort the animation's signal. That is normal
        // disposal inside this handoff, not cancellation of the new selection.
        parent.removeEventListener('abort', cancel);
        try { handoff(); phase = 'committed'; }
        catch (error) { phase = 'cancelled'; controller.abort(); throw error; }
        finally { release(); }
        return true;
      },
    };
    // An obsolete callback has no authority to revoke the current allocation.
    if (parent.aborted || !ownerIsCurrent()) cancel();
    else {
      // Abort listeners and allocation cleanup run synchronously and may start
      // a newer request. Reserve intent before invoking them, then revalidate.
      const intent = this.intent = Symbol('scene-intent');
      this.current?.cancel();
      if (this.intent !== intent || parent.aborted || !ownerIsCurrent()) cancel();
      else { this.current = scene; parent.addEventListener('abort', cancel, { once: true }); this.changed(scene); }
    }
    return scene;
  }
}
