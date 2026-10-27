import type { ComponentType } from "react";

import type { ExtensionPlatform } from "@opencraft/extension-contract";
import type {
  ComposerTransientTextInput,
  ComposerTransientTextInputObserver,
} from "@opencraft/composer-core";

/** Host-owned capabilities passed to a trusted Composer action. */
export interface ComposerMutationService {
  insertText(text: string): void;
  beginTransientTextInput(
    observer?: ComposerTransientTextInputObserver,
  ): ComposerTransientTextInput | null;
  focus(): void;
}

export interface ComposerActionHost {
  /** Narrow View-owned mutation port; extensions never own the controller. */
  readonly mutations: ComposerMutationService;
  readonly disabled: boolean;
  readonly platform: ExtensionPlatform;
}

export interface ComposerActionRendererContribution {
  readonly id: string;
  readonly order?: number;
  readonly Component: ComponentType<ComposerActionHost>;
}

export interface OwnedComposerActionRenderer
  extends ComposerActionRendererContribution {
  readonly ownerId: string;
}

export interface ComposerActionRendererSnapshot {
  readonly revision: number;
  readonly actions: readonly OwnedComposerActionRenderer[];
}

/**
 * React-only trusted seam. The stable extension contract never receives a
 * ComposerController or a framework component.
 */
export class ComposerActionRendererRegistry {
  private readonly records = new Map<string, OwnedComposerActionRenderer>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ComposerActionRendererSnapshot = Object.freeze({
    revision: 0,
    actions: [],
  });

  getSnapshot = (): ComposerActionRendererSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register(
    ownerId: string,
    contribution: ComposerActionRendererContribution,
  ): () => void {
    const id = contribution.id.trim();
    if (id.length === 0) {
      throw new RangeError("Composer action renderer requires an ID");
    }
    if (this.records.has(id)) {
      throw new Error(`Composer action renderer ${id} is already registered`);
    }
    const record = Object.freeze({
      ownerId,
      id,
      order: contribution.order,
      Component: contribution.Component,
    });
    this.records.set(id, record);
    this.publish();
    return () => {
      if (this.records.get(id) !== record) return;
      this.records.delete(id);
      this.publish();
    };
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      actions: Object.freeze(
        [...this.records.values()].sort(
          (left, right) =>
            (left.order ?? 0) - (right.order ?? 0) ||
            left.id.localeCompare(right.id),
        ),
      ),
    });
    for (const listener of this.listeners) listener();
  }
}
