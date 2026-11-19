import type { ExtensionAccountPreferences, ExtensionLocalPreferenceStore } from "@opencraft/extension-contract";
import type { ThreadListGroupingContribution, ThreadListGroupingSnapshot, ThreadListGroup, ThreadListReference } from "@opencraft/extension-react";
import { TENCENTOA_PROVIDER_ID } from "./contract";
import type { TencentOaController } from "./controller";
import type { TencentOaParticipantsController } from "./participants-controller";
import { employeePhotoUrl } from "./photo";

const modes = [{ id: "creator", label: { id: "ioa.grouping.creator", defaultMessage: "By creator" } }] as const;
const key = "thread-list.v1";
type Preferences = { mode: "creator" | null; collapsed: string[]; mineEnabled: boolean };
function parse(value: unknown): Preferences {
  if (!value || typeof value !== "object" || !("mode" in value) || !("collapsed" in value)
    || (value.mode !== null && value.mode !== "creator") || !Array.isArray(value.collapsed)
    || ("mineEnabled" in value && typeof value.mineEnabled !== "boolean")
    || value.collapsed.length > 1000 || value.collapsed.some(id => typeof id !== "string" || id.length > 160)) return { mode: null, collapsed: [], mineEnabled: false };
  return { mode: value.mode, collapsed: [...new Set(value.collapsed)], mineEnabled: "mineEnabled" in value && value.mineEnabled === true };
}

// The signature consumes identity and order, not catalog timestamps or pins.
function sameThreadIdentities(left: readonly ThreadListReference[], right: readonly ThreadListReference[]): boolean {
  return left.length === right.length && left.every((thread, index) =>
    thread.hostId === right[index]!.hostId && thread.threadId === right[index]!.threadId);
}

/** IOA owns creator semantics and its preference schema; neither lives in the Shell. */
export class TencentOaCreatorGrouping implements ThreadListGroupingContribution {
  readonly id = "tencentoa.identity.creator-grouping";
  readonly #listeners = new Set<() => void>();
  readonly #disposers: (() => void)[];
  #store: ExtensionLocalPreferenceStore | null = null;
  #removeStore: (() => void) | null = null;
  #account: string | null = null;
  #name: string | null = null;
  #preferences: Preferences = { mode: null, collapsed: [], mineEnabled: false };
  #snapshot: ThreadListGroupingSnapshot = { revision: 0, mode: null, modes, hideRowBadge: false, notice: null };
  #closed = false;
  readonly #watches = new Map<symbol, readonly ThreadListReference[]>();
  #metadataSignature = "";
  constructor(readonly identity: TencentOaController, readonly participants: TencentOaParticipantsController,
    readonly storage: ExtensionAccountPreferences | null) {
    this.#updateAccount();
    this.#disposers = [identity.subscribe(() => this.#updateAccount()), participants.subscribe(() => {
      const signature = this.#readMetadataSignature();
      if (signature !== this.#metadataSignature) this.#publish();
    })];
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #updateAccount(): void {
    // Display-only association preserves personal layout during revalidation, never authorization.
    const identity = this.identity.getSnapshot().displayIdentity;
    const account = identity ? `${TENCENTOA_PROVIDER_ID}:${identity.staffId}` : null;
    const name = identity?.loginName ?? null;
    if (account === this.#account) { if (name !== this.#name) { this.#name = name; this.#publish(); } return; }
    this.#account = account; this.#name = name;
    this.#removeStore?.(); this.#removeStore = null; this.#store = null;
    this.#preferences = { mode: null, collapsed: [], mineEnabled: false };
    this.#snapshot = { ...this.#snapshot, notice: null };
    try {
      if (account && this.storage) {
        this.#store = this.storage.forAccount(account);
        this.#preferences = parse(this.#store.get(key));
        this.#removeStore = this.#store.subscribe(() => {
          if (!this.#closed && this.#account === account) {
            try { this.#preferences = parse(this.#store!.get(key)); this.#publish(null); }
            catch { this.#publish({ id: "ioa.grouping.saveError", defaultMessage: "Couldn't save this display preference" }); }
          }
        });
      }
      this.#publish(null);
    } catch { this.#publish({ id: "ioa.grouping.saveError", defaultMessage: "Couldn't save this display preference" }); }
  }
  #publish(notice = this.#snapshot.notice): void {
    if (this.#closed) return;
    this.#metadataSignature = this.#readMetadataSignature();
    this.#snapshot = { revision: this.#snapshot.revision + 1, mode: this.#preferences.mode, modes,
      hideRowBadge: this.#preferences.mode !== null, notice,
      ...(this.#account === null ? {} : { filter: { label: { id: "ioa.filter.mine", defaultMessage: "My conversations" }, enabled: this.#preferences.mineEnabled } }) };
    for (const listener of this.#listeners) listener();
  }
  #save(): void {
    if (this.#closed) return;
    try { this.#store?.set(key, this.#preferences); this.#publish(null); }
    catch { this.#publish({ id: "ioa.grouping.saveError", defaultMessage: "Couldn't save this display preference" }); }
  }
  setMode = (mode: string | null): void => {
    if (this.#closed || (mode !== null && mode !== "creator")) return;
    this.#preferences = { ...this.#preferences, mode }; this.#save();
  };
  toggleGroup = (id: string): void => {
    if (this.#closed || !id || id.length > 160) return;
    const collapsed = new Set(this.#preferences.collapsed);
    if (collapsed.has(id)) collapsed.delete(id); else if (collapsed.size < 1000) collapsed.add(id);
    this.#preferences = { ...this.#preferences, collapsed: [...collapsed] }; this.#save();
  };
  watch = (threads: readonly ThreadListReference[]): (() => void) => {
    if (this.#closed || !this.#name) return () => {};
    const lease = Symbol();
    const sameSoleWatch = this.#watches.size === 1
      && sameThreadIdentities(this.#watches.values().next().value!, threads);
    this.#watches.set(lease, threads);
    if (!sameSoleWatch) this.#metadataSignature = this.#readMetadataSignature();
    // Watching remains mounted while a group is collapsed; row badges need not exist.
    const remove = threads.map(thread => this.participants.watch(thread.hostId, thread.threadId));
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#watches.delete(lease);
      remove.forEach(dispose => dispose());
      // Only an identical sole successor preserves the ordered union. Other
      // overlapping leases and reorders still take the original full path.
      if (this.#watches.size !== 1
        || !sameThreadIdentities(this.#watches.values().next().value!, threads)) {
        this.#metadataSignature = this.#readMetadataSignature();
      }
    };
  };
  #readMetadataSignature(): string {
    const rows = new Map<string, readonly unknown[]>();
    for (const threads of this.#watches.values()) for (const thread of threads) {
      const id = JSON.stringify([thread.hostId, thread.threadId]);
      if (rows.has(id)) continue;
      const snapshot = this.participants.getSnapshot(thread.hostId, thread.threadId);
      const name = snapshot.data?.creator ?? null;
      // Badges own participant counts; the list owns membership and, when
      // selected, creator groups. Metadata revisions alone change neither.
      rows.set(id, [id, Boolean(this.#name && snapshot.data && (name === this.#name || snapshot.data.participants.includes(this.#name))), this.#preferences.mode === "creator"
        ? name ? ["known", name] : [snapshot.data || snapshot.phase === "unsupported" ? "unknown" : snapshot.phase === "error" ? "error" : "loading"]
        : null]);
    }
    return JSON.stringify([...rows.values()]);
  }
  setFilterEnabled = (enabled: boolean): void => {
    if (this.#closed) return;
    this.#preferences = { ...this.#preferences, mineEnabled: enabled }; this.#save();
  };
  isParticipant = (thread: ThreadListReference): boolean => {
    if (this.#closed || !this.#name) return false;
    if (thread.createdByViewer === true) return true;
    const data = this.participants.getSnapshot(thread.hostId, thread.threadId).data;
    return data !== null && data !== undefined
      && (data.creator === this.#name || data.participants.includes(this.#name));
  };
  filterThreads = (threads: readonly ThreadListReference[]): readonly ThreadListReference[] => {
    if (!this.#preferences.mineEnabled || !this.#name) return threads;
    return threads.filter(this.isParticipant);
  };
  project = (threads: readonly ThreadListReference[]): readonly ThreadListGroup[] => {
    const groups = new Map<string, { name: string | null; state: string; threads: ThreadListReference[] }>();
    for (const thread of threads) {
      const snapshot = this.participants.getSnapshot(thread.hostId, thread.threadId);
      const name = snapshot.data?.creator ?? null;
      const state = name ? "known" : snapshot.data || snapshot.phase === "unsupported" ? "unknown" : snapshot.phase === "error" ? "error" : "loading";
      const id = name ? `employee:${name}` : state;
      let group = groups.get(id); if (!group) { group = { name, state, threads: [] }; groups.set(id, group); }
      group.threads.push(thread);
    }
    const order = (name: string | null) => name === this.#name && name !== null ? 0 : name !== null ? 1 : 2;
    return [...groups].sort(([a, left], [b, right]) => order(left.name) - order(right.name)
      || (left.name && right.name ? left.name.toLowerCase().localeCompare(right.name.toLowerCase(), "en") || left.name.localeCompare(right.name, "en") : a.localeCompare(b, "en")))
      .map(([id, group]) => ({ id, avatarUrl: group.name ? employeePhotoUrl(group.name) : null,
        label: group.name ?? (group.state === "loading" ? { id: "ioa.grouping.loading", defaultMessage: "Loading creators…" }
          : group.state === "error" ? { id: "ioa.grouping.unavailable", defaultMessage: "Creator unavailable" }
          : { id: "ioa.grouping.unknown", defaultMessage: "Creator unknown" }),
        collapsed: this.#preferences.collapsed.includes(id),
        threads: group.threads.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt),
      }));
  };
  dispose(): void {
    this.#closed = true; this.#removeStore?.(); this.#disposers.forEach(dispose => dispose()); this.#listeners.clear(); this.#watches.clear(); this.#store = null;
  }
}
