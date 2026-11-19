import type { Context } from "@deepseek-ai/cordis";
export const OfficePreviewPlugin = Object.assign(function OfficePreviewPlugin(ctx: Context) {
  const remove = ctx.filePreviews.register({
    id: "office.readonly", extensions: ["doc", "docx", "pptx", "xlsx", "xls", "xlsm"],
    async open(input) {
      const { openOfficeDocument } = await import("./office-document");
      input.signal.throwIfAborted();
      const styles = await import("./preview.web.scss?inline");
      input.signal.throwIfAborted();
      return { ...await openOfficeDocument(input), styles: styles.default };
    },
  });
  ctx.effect(() => remove);
}, { inject: ["filePreviews"] });
