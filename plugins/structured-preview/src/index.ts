import type { Context } from "@deepseek-ai/cordis";

export const StructuredPreviewPlugin = Object.assign(function StructuredPreviewPlugin(ctx: Context) {
  const remove = ctx.filePreviews.register({
    id: "structured.readonly",
    extensions: ["csv", "tsv", "drawio", "dio", "excalidraw", "mmd", "mermaid"],
    async open(input) {
      if (/\.(csv|tsv)$/iu.test(input.name)) {
        const { openDelimited } = await import("./delimited");
        input.signal.throwIfAborted();
        return openDelimited(input);
      }
      const { openDiagram } = await import("./diagram");
      input.signal.throwIfAborted();
      return openDiagram(input);
    },
  });
  ctx.effect(() => remove);
}, { inject: ["filePreviews"] });
