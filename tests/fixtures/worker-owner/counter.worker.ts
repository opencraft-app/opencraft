import { serveWorkerOwner } from "../../../packages/worker-owner/src/serve.ts";
import { Counter, CounterError } from "./counter.ts";

serveWorkerOwner((data: { closedMarker?: string; refuse?: boolean } = {}) => {
  if (data.refuse) throw new CounterError("negative", 503);
  const counter = new Counter(data.closedMarker);
  return {
    ready: { opened: true },
    methods: {
      add: (amount: number) => counter.add(amount),
      slowAdd: (amount: number, delayMs: number) => counter.slowAdd(amount, delayMs),
      lose: () => counter.lose(),
      crash: () => counter.crash(),
    },
    close: () => counter.close(),
  };
});
