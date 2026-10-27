import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import ImageEditor from "./editor";
import styles from "./editor.web.scss?inline";

export function createImageEditorExtension(): TrustedExtensionDefinition {
  return {
    manifest: {
      manifestVersion: 1, id: "opencraft.image-editor", name: "Image editor",
      description: "Draw, add text and stickers, crop and pixelate draft images in the browser.",
      version: "0.1.0", apiVersion: 1, trust: "trusted",
      platforms: ["web", "electron"], activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      api.internal.register("imageEditor", { id: "opencraft.image-editor", Component: ImageEditor, styles });
    },
  };
}
