import { Context } from "@deepseek-ai/cordis";
import { ImageProcessingService } from "@opencraft/image-processing";
import { processBrowserImage } from "@opencraft/image-processing/browser";
import { resolveBrowserAttachment } from "../../apps/workbench-web/src/runtime/browser-attachment-resolver";
const ctx = new Context();
await ctx.plugin(ImageProcessingService, { process: processBrowserImage });
Object.assign(window, {
  images: ctx.imageProcessing,
  resolveBrowserAttachment,
});
