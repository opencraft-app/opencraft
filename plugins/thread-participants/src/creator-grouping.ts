import type { ExtensionAccountPreferences, ExtensionLocalPreferenceStore } from "@opencraft/extension-contract";
import type {
  ThreadListGroup,
  ThreadListGroupingContribution,
  ThreadListGroupingSnapshot,
  ThreadListLabel,
  ThreadListReference,
} from "@opencraft/extension-react";
import { THREAD_PARTICIPANT_IDENTITY_KIND } from "./contract";
import type { ThreadParticipantsSource } from "./controller";

/** The current reader as the identity product verified it. Display association only, never authorization. */
export interface ThreadParticipantsViewerIdentity {
  /** Stable account key that isolates personal list preferences. */
  readonly accountKey: string;
  /** The reader's verified sender name, as recorded on their messages. */
  readonly loginName: string;
}
export interface ThreadParticipantsViewer {
  getSnapshot(): ThreadParticipantsViewerIdentity | null;
  subscribe(listener: () => void): () => void;
}

export const CREATOR_GROUPING_MODE = "creator";
const GROUP_PREFIX = `${THREAD_PARTICIPANT_IDENTITY_KIND}:`;
const PREFERENCES_KEY = "thread-list.v1";
const modes = [
  { id: CREATOR_GROUPING_MODE, label: { id: "threadParticipants.grouping.creator", defaultMessage: "By creator" } },
] as const;
const saveError: ThreadListLabel = {
  id: "threadParticipants.grouping.saveError",
  defaultMessage: "Couldn't save this display preference",
};
const mineFilter: ThreadListLabel = { id: "threadParticipants.filter.mine", defaultMessage: "My conversations" };
const groupLabels = {
  loading: { id: "threadParticipants.grouping.loading", defaultMessage: "Loading creators…" },
  error: { id: "threadParticipants.grouping.unavailable", defaultMessage: "Creator unavailable" },
  unknown: { id: "threadParticipants.grouping.unknown", defaultMessage: "Creator unknown" },
} as const satisfies Record<string, ThreadListLabel>;

type Preferences = { mode: typeof CREATOR_GROUPING_MODE | null; collapsed: string[]; mineEnabled: boolean };
const defaults = (): Preferences => ({ mode: null, collapsed: [], mineEnabled: false });
/** Missing, legacy and malformed values default off; reading never rewrites the saved value. */
export function parseCreatorGroupingPreferences(value: unknown): Preferences {
  if (
    !value ||
    typeof value !== "object" ||
    !("mode" in value) ||
    !("collapsed" in value) ||
    (value.mode !== null && value.mode !== CREATOR_GROUPING_MODE) ||
    !Array.isArray(value.collapsed) ||
    ("mineEnabled" in value && typeof value.mineEnabled !== "boolean") ||
    value.collapsed.length > 1000 ||
    value.collapsed.some((id) => typeof id !== "string" || id.length > 160)
  )
    return defaults();
  return {
    mode: value.mode,
    collapsed: [...new Set(value.collapsed as string[])],
    mineEnabled: "mineEnabled" in value && value.mineEnabled === true,
  };
}

// The signature consumes identity and order, not catalog timestamps or pins.
function sameThreadIdentities(left: readonly ThreadListReference[], right: readonly ThreadListReference[]): boolean {
  return (
    left.length === right.length &&
    left.every((thread, index) => thread.hostId === right[index]!.hostId && thread.threadId === right[index]!.threadId)
  );
}

type GroupState = "known" | keyof typeof groupLabels;

/**
 * "Group by creator" and the personal "My conversations" filter for the
 * Shell's thread list. The Shell owns layout, menus and the filter disclosure;
 * this contribution owns creator semantics and its own preference schema.
 */
export class CreatorGrouping implements ThreadListGroupingContribution {
  readonly #listeners = new Set<() => void>();
  readonly #disposers: (() => void)[];
  readonly #watches = new Map<symbol, readonly ThreadListReference[]>();
  #store: ExtensionLocalPreferenceStore | null = null;
  #removeStore: (() => void) | null = null;
  #account: string | null = null;
  #name: string | null = null;
  #preferences = defaults();
  #snapshot: ThreadListGroupingSnapshot = { revision: 0, mode: null, modes, hideRowBadge: false, notice: null };
  #closed = false;
  #metadataSignature = "";

  constructor(
    readonly id: string,
    readonly viewer: ThreadParticipantsViewer,
    readonly participants: ThreadParticipantsSource,
    readonly storage: ExtensionAccountPreferences | null = null,
  ) {
    this.#updateAccount();
    this.#disposers = [
      viewer.subscribe(() => this.#updateAccount()),
      participants.subscribe(() => {
        const signature = this.#readMetadataSignature();
        if (signature !== this.#metadataSignature) this.#publish();
      }),
    ];
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  setMode = (mode: string | null): void => {
    if (this.#closed || (mode !== null && mode !== CREATOR_GROUPING_MODE)) return;
    this.#preferences = { ...this.#preferences, mode };
    this.#save();
  };
  toggleGroup = (id: string): void => {
    if (this.#closed || !id || id.length > 160) return;
    const collapsed = new Set(this.#preferences.collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else if (collapsed.size < 1000) collapsed.add(id);
    this.#preferences = { ...this.#preferences, collapsed: [...collapsed] };
    this.#save();
  };
  setFilterEnabled = (enabled: boolean): void => {
    if (this.#closed) return;
    this.#preferences = { ...this.#preferences, mineEnabled: enabled };
    this.#save();
  };
  watch = (threads: readonly ThreadListReference[]): (() => void) => {
    if (this.#closed || !this.#name) return () => {};
    const lease = Symbol();
    const sameSoleWatch =
      this.#watches.size === 1 && sameThreadIdentities(this.#watches.values().next().value!, threads);
    this.#watches.set(lease, threads);
    if (!sameSoleWatch) this.#metadataSignature = this.#readMetadataSignature();
    // Watching remains mounted while a group is collapsed; row badges need not exist.
    const remove = threads.map((thread) => this.participants.watch(thread.hostId, thread.threadId));
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#watches.delete(lease);
      remove.forEach((dispose) => dispose());
      // Only an identical sole successor preserves the ordered union.
      if (this.#watches.size !== 1 || !sameThreadIdentities(this.#watches.values().next().value!, threads)) {
        this.#metadataSignature = this.#readMetadataSignature();
      }
    };
  };
  /** Positive evidence only: authenticated creation or a verified participant row. */
  isParticipant = (thread: ThreadListReference): boolean => {
    if (this.#closed || !this.#name) return false;
    if (thread.createdByViewer === true) return true;
    const data = this.participants.getSnapshot(thread.hostId, thread.threadId).data;
    return data != null && (data.creator === this.#name || data.participants.includes(this.#name));
  };
  filterThreads = (threads: readonly ThreadListReference[]): readonly ThreadListReference[] => {
    if (!this.#preferences.mineEnabled || !this.#name) return threads;
    return threads.filter(this.isParticipant);
  };
  project = (threads: readonly ThreadListReference[]): readonly ThreadListGroup[] => {
    const groups = new Map<string, { name: string | null; state: GroupState; threads: ThreadListReference[] }>();
    for (const thread of threads) {
      const { name, state } = this.#creator(thread);
      const id = name ? GROUP_PREFIX + name : state;
      let group = groups.get(id);
      if (!group) {
        group = { name, state, threads: [] };
        groups.set(id, group);
      }
      group.threads.push(thread);
    }
    const order = (name: string | null) => (name !== null && name === this.#name ? 0 : name !== null ? 1 : 2);
    return [...groups]
      .sort(
        ([a, left], [b, right]) =>
          order(left.name) - order(right.name) ||
          (left.name && right.name
            ? left.name.toLowerCase().localeCompare(right.name.toLowerCase(), "en") ||
              left.name.localeCompare(right.name, "en")
            : a.localeCompare(b, "en")),
      )
      .map(([id, group]) => ({
        id,
        avatarUrl: null,
        ...(group.name ? { identity: { kind: THREAD_PARTICIPANT_IDENTITY_KIND, name: group.name } } : {}),
        label: group.name ?? groupLabels[group.state as keyof typeof groupLabels],
        collapsed: this.#preferences.collapsed.includes(id),
        threads: group.threads.sort(
          (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt,
        ),
      }));
  };
  dispose(): void {
    this.#closed = true;
    this.#removeStore?.();
    this.#disposers.forEach((dispose) => dispose());
    this.#listeners.clear();
    this.#watches.clear();
    this.#store = null;
  }

  #creator(thread: ThreadListReference): { name: string | null; state: GroupState } {
    const snapshot = this.participants.getSnapshot(thread.hostId, thread.threadId);
    const name = snapshot.data?.creator ?? null;
    return {
      name,
      state: name
        ? "known"
        : snapshot.data || snapshot.phase === "unsupported"
          ? "unknown"
          : snapshot.phase === "error"
            ? "error"
            : "loading",
    };
  }
  #updateAccount(): void {
    // Display-only association preserves personal layout during revalidation, never authorization.
    const identity = this.viewer.getSnapshot();
    const account = identity?.accountKey ?? null,
      name = identity?.loginName ?? null;
    if (account === this.#account) {
      if (name !== this.#name) {
        this.#name = name;
        this.#publish();
      }
      return;
    }
    this.#account = account;
    this.#name = name;
    this.#removeStore?.();
    this.#removeStore = null;
    this.#store = null;
    this.#preferences = defaults();
    this.#snapshot = { ...this.#snapshot, notice: null };
    try {
      if (account && this.storage) {
        const store = this.storage.forAccount(account);
        this.#store = store;
        this.#preferences = parseCreatorGroupingPreferences(store.get(PREFERENCES_KEY));
        this.#removeStore = store.subscribe(() => {
          if (this.#closed || this.#account !== account) return;
          try {
            this.#preferences = parseCreatorGroupingPreferences(store.get(PREFERENCES_KEY));
            this.#publish(null);
          } catch {
            this.#publish(saveError);
          }
        });
      }
      this.#publish(null);
    } catch {
      this.#publish(saveError);
    }
  }
  #publish(notice = this.#snapshot.notice): void {
    if (this.#closed) return;
    this.#metadataSignature = this.#readMetadataSignature();
    this.#snapshot = {
      revision: this.#snapshot.revision + 1,
      mode: this.#preferences.mode,
      modes,
      hideRowBadge: this.#preferences.mode !== null,
      notice,
      ...(this.#account === null ? {} : { filter: { label: mineFilter, enabled: this.#preferences.mineEnabled } }),
    };
    for (const listener of this.#listeners) listener();
  }
  #save(): void {
    if (this.#closed) return;
    try {
      this.#store?.set(PREFERENCES_KEY, this.#preferences);
      this.#publish(null);
    } catch {
      this.#publish(saveError);
    }
  }
  #readMetadataSignature(): string {
    const rows = new Map<string, readonly unknown[]>();
    for (const threads of this.#watches.values())
      for (const thread of threads) {
        const id = JSON.stringify([thread.hostId, thread.threadId]);
        if (rows.has(id)) continue;
        const data = this.participants.getSnapshot(thread.hostId, thread.threadId).data;
        // Badges own participant counts; the list owns membership and, when
        // selected, creator groups. Metadata revisions alone change neither.
        const member = Boolean(
          this.#name && data && (data.creator === this.#name || data.participants.includes(this.#name)),
        );
        const creator = this.#preferences.mode === CREATOR_GROUPING_MODE ? this.#creator(thread) : null;
        rows.set(id, [id, member, creator ? [creator.state, creator.name] : null]);
      }
    return JSON.stringify([...rows.values()]);
  }
}
