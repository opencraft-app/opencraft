import type { AppServerNotification } from "@opencraft/appserver-protocol";

import { preview } from "./reporter";

export interface NotificationJournalEntry {
  method: string;
  count: number;
  samples: readonly unknown[];
}

export interface NotificationObservation {
  count: number;
  emitSample: boolean;
  emitSuppressedMarker: boolean;
}

/** Counts every notification but emits only a bounded sample per method. */
export class NotificationJournal {
  private readonly entries = new Map<string, { count: number; samples: unknown[] }>();

  constructor(private readonly samplesPerMethod = 3) {}

  handle(notification: AppServerNotification): NotificationObservation {
    const entry = this.entries.get(notification.method) ?? { count: 0, samples: [] };
    entry.count += 1;
    const emitSample = entry.samples.length < this.samplesPerMethod;
    if (emitSample) entry.samples.push(preview(notification.params));
    this.entries.set(notification.method, entry);
    return {
      count: entry.count,
      emitSample,
      emitSuppressedMarker: entry.count === this.samplesPerMethod + 1,
    };
  }

  getSnapshot(): readonly NotificationJournalEntry[] {
    return [...this.entries.entries()]
      .map(([method, entry]) => ({ method, count: entry.count, samples: [...entry.samples] }))
      .sort((left, right) => right.count - left.count || left.method.localeCompare(right.method));
  }
}
