import { defineTool } from "@earendil-works/pi-durable";
import { assistantTools as definitions } from "../work-tools/assistant-tools.mjs";
export function assistantTools(options) {
  return definitions(options).map((tool) =>
    defineTool({
      ...tool,
      execute: (args, api, context) =>
        tool.execute(args, api, {
          ...context,
          suspend: async () => {
            const signal = context.abortSignal;
            if (!signal) throw new Error("Pi tool cancellation context is required");
            const stopped = new Promise((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
            });
            options.onInteractionWait();
            await stopped;
            throw new Error("Unreachable Pi wait");
          },
        }),
    }),
  );
}
