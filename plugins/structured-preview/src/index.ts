import type { Context } from "@deepseek-ai/cordis";

export const StructuredPreviewPlugin = Object.assign(function StructuredPreviewPlugin(ctx: Context) {
  const remove = ctx.filePreviews.register({
    id: "structured.readonly",
    extensions: ["csv", "tsv", "drawio", "dio", "excalidraw", "mmd", "mermaid"],
    async open(input) {
      if (/\.(csv|tsv)$/iu.test(input.name)) {
        const { openDelimited } = await import("./delimited");
        input.signal.throwIfAborted();
        const styles = await import("./preview.web.scss?inline");
        input.signal.throwIfAborted();
        return { ...await openDelimited(input), styles: styles.default };
      }
      const { openDiagram } = await import("./diagram");
      input.signal.throwIfAborted();
      const styles = await import("./preview.web.scss?inline");
      input.signal.throwIfAborted();
      return { ...await openDiagram(input), styles: styles.default };
    },
  });
  ctx.effect(() => remove);
}, { inject: ["filePreviews"] });
