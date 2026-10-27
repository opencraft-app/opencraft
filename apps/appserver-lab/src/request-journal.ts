import type { AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";

import { preview } from "./reporter";

export interface RequestJournalEntry {
  id: string | number;
  hostId: string;
  method: string;
  priority?: string;
  status: "pending" | "completed" | "failed" | "timed-out" | "aborted";
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  paramsPreview: unknown;
  resultPreview: unknown;
  errorPreview: unknown;
}

/** A bounded diagnostic projection of request lifecycle events. */
export class RequestJournal {
  private entries: RequestJournalEntry[] = [];

  constructor(private readonly capacity = 100) {}

  handle(event: AppServerRequestLifecycleEvent): void {
    if (event.type === "started") {
      const entry: RequestJournalEntry = {
        id: event.id,
        hostId: event.hostId,
        method: event.method,
        ...(event.priority === undefined ? {} : { priority: event.priority }),
        status: "pending",
        startedAtMs: event.startedAtMs,
        endedAtMs: null,
        durationMs: null,
        paramsPreview: preview(event.params),
        resultPreview: null,
        errorPreview: null,
      };
      this.entries = [entry, ...this.entries].slice(0, this.capacity);
      return;
    }
    if (event.type === "queued" || event.type === "late-response") return;
    const entry = this.entries.find((candidate) => candidate.id === event.id);
    if (entry === undefined) return;
    entry.status = event.type;
    entry.endedAtMs = event.endedAtMs;
    entry.durationMs = event.durationMs;
    if (event.type === "completed") entry.resultPreview = preview(event.result);
    else entry.errorPreview = preview(event.error);
  }

  getSnapshot(): readonly RequestJournalEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
