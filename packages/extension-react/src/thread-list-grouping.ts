export const THREAD_LIST_GROUPING_CHANNEL = "threadListGrouping";
export type ThreadListLabel = string | { readonly id: string; readonly defaultMessage: string };
export interface ThreadListReference {
  readonly hostId: string;
  readonly threadId: string;
  readonly updatedAt: number;
  readonly pinned?: boolean;
}
export interface ThreadListGroup {
  readonly id: string;
  readonly label: ThreadListLabel;
  readonly avatarUrl: string | null;
  readonly collapsed: boolean;
  readonly threads: readonly ThreadListReference[];
}
export interface ThreadListGroupingSnapshot {
  readonly revision: number;
  /** null restores the Shell's standard activity list. Mode IDs belong to the plugin. */
  readonly mode: string | null;
  readonly modes: readonly { readonly id: string; readonly label: ThreadListLabel }[];
  readonly hideRowBadge: boolean;
  readonly notice: ThreadListLabel | null;
  /** Optional product-owned personal filter; no identity data crosses into Shell. */
  readonly filter?: { readonly label: ThreadListLabel; readonly enabled: boolean };
}
/** Product-owned grouping/personal preferences, platform-owned layout/navigation/menu chrome. */
export interface ThreadListGroupingContribution {
  readonly id: string;
  getSnapshot(): ThreadListGroupingSnapshot;
  subscribe(listener: () => void): () => void;
  watch(threads: readonly ThreadListReference[]): () => void;
  project(threads: readonly ThreadListReference[]): readonly ThreadListGroup[];
  /** Positive product-owned participation evidence, independent of the active filter. */
  isParticipant?(thread: ThreadListReference): boolean;
  filterThreads?(threads: readonly ThreadListReference[]): readonly ThreadListReference[];
  setFilterEnabled?(enabled: boolean): void;
  setMode(mode: string | null): void;
  toggleGroup(groupId: string): void;
}
