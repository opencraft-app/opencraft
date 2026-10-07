import { Asset } from "expo-asset";
import { File } from "expo-file-system";

let pending: Promise<string> | null = null;

/** The renderer ships inside the app and is read only when a diagram appears. */
export function loadMobileChatMermaidHtml(): Promise<string> {
  pending ??= (async () => {
    const asset = Asset.fromModule(require("../../assets/mobile-chat-mermaid.html") as number);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error("Embedded diagram renderer unavailable");
    return new File(asset.localUri).text();
  })().catch(error => {
    pending = null;
    throw error;
  });
  return pending;
}
