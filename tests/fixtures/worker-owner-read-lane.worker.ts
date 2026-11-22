import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { writeFile } from "node:fs/promises";
serveWorkerOwner<{ file: string }>(({ file }) => {
  let value = 0,
    writing = false;
  return {
    concurrentReads: ["peek", "badRead"],
    methods: {
      async write(next: number) {
        writing = true;
        await new Promise((r) => setTimeout(r, 200));
        value = next;
        writing = false;
        return value;
      },
      peek() {
        return { value, writing };
      },
      badRead() {
        return Promise.resolve(value);
      },
    },
    async close() {
      await writeFile(file, JSON.stringify({ value, writing }));
    },
  };
});
