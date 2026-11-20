import { requireText, requireRevision } from "./values.mjs";

export class MemoryEntry {
  static change(previous, { key, value, expectedRevision }, inputId, forget) {
    requireText(key, "key", 160);
    if (!forget) requireText(value, "value");
    requireRevision(expectedRevision, previous?.revision ?? 0, "memory");
    return {
      key,
      value: forget ? "" : value,
      revision: (previous?.revision ?? 0) + 1,
      input_id: inputId,
      deleted: forget ? 1 : 0,
    };
  }
}
