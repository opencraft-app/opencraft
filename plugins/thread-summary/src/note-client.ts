import * as Y from "yjs";
import type { ConversationNoteTransport } from "@opencraft/workbench-panels-react";

export const localEdit = Symbol("note-edit");
export const remoteEdit = Symbol("note-remote");
export const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
export const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), char => char.charCodeAt(0));
export type NoteStatus = "loading" | "saved" | "saving" | "offline";

/** One CRDT per captured conversation. Closing its view does not discard pending edits. */
export class ThreadNoteClient {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("markdown");
  readonly undo = new Y.UndoManager(this.text, { trackedOrigins: new Set([localEdit]) });
  private listeners = new Set<() => void>();
  private revision = 0;
  private acknowledged = 0;
  private vector: Uint8Array = new Uint8Array([0]);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private paused = false;
  private closed = false;
  private failures = 0;
  private deferred: Uint8Array[] = [];
  private snapshot = { markdown: "", status: "loading" as NoteStatus, ready: false };
  constructor(private readonly transport: ConversationNoteTransport) {
    this.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== remoteEdit) this.revision++;
      this.publish({ markdown: this.text.toString(), ...(origin !== remoteEdit ? { status: "saving" as const } : {}) });
      if (origin !== remoteEdit) this.schedule(100);
    });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.schedule(0);
    return () => { this.listeners.delete(listener); if (!this.listeners.size && this.revision === this.acknowledged) clearTimeout(this.timer); };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (next.markdown === this.snapshot.markdown && next.status === this.snapshot.status && next.ready === this.snapshot.ready) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), delay);
  }
  async sync() {
    if (this.running || this.closed) return;
    this.running = true;
    const revision = this.revision, vector = Y.encodeStateVector(this.doc);
    try {
      const result = await this.transport.exchange(revision !== this.acknowledged ? encode(Y.encodeStateAsUpdate(this.doc, this.vector)) : "", encode(vector));
      if (this.closed) return;
      const update = decode(result.update);
      if (this.paused) this.deferred.push(update); else Y.applyUpdate(this.doc, update, remoteEdit);
      this.failures = 0;
      this.vector = vector;
      this.acknowledged = revision;
      this.publish({ ready: true, status: this.revision === this.acknowledged ? "saved" : "saving" });
    } catch {
      this.failures++;
      this.publish({ status: "offline" });
    } finally {
      this.running = false;
      if (!this.closed && (this.listeners.size || this.revision !== this.acknowledged && this.failures < 6)) this.schedule(this.snapshot.status === "offline" ? 5000 : this.revision !== this.acknowledged ? 100 : 1500);
    }
  }
  close() { this.closed = true; clearTimeout(this.timer); this.undo.destroy(); this.doc.destroy(); }
  composition(active: boolean) {
    this.paused = active;
    if (!active) { for (const update of this.deferred.splice(0)) Y.applyUpdate(this.doc, update, remoteEdit); }
  }
  replace(value: string) {
    if (!this.snapshot.ready || value === this.text.toString()) return;
    const previous = this.text.toString();
    let start = 0, end = 0;
    while (start < previous.length && start < value.length && previous[start] === value[start]) start++;
    while (end < previous.length - start && end < value.length - start && previous[previous.length - 1 - end] === value[value.length - 1 - end]) end++;
    // Never split a UTF-16 surrogate pair when finding the changed range.
    const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
    if (start > 0 && low(previous.charCodeAt(start))) start--;
    if (end > 0 && low(previous.charCodeAt(previous.length - end))) end--;
    this.doc.transact(() => {
      this.text.delete(start, previous.length - start - end);
      this.text.insert(start, value.slice(start, value.length - end));
    }, localEdit);
  }
}

const clients = new WeakMap<ConversationNoteTransport, ThreadNoteClient>();
export function conversationNote(transport: ConversationNoteTransport) {
  let client = clients.get(transport);
  if (!client) { client = new ThreadNoteClient(transport); clients.set(transport, client); }
  return client;
}
