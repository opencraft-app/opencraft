import { Asset } from "expo-asset";
import { File } from "expo-file-system";

let pending: Promise<string> | null = null;

/** Keep the typesetter in the app package and read it only for display math. */
export function loadMobileChatMathHtml(): Promise<string> {
  pending ??= (async () => {
    const asset = Asset.fromModule(require("../../assets/mobile-chat-math.html") as number);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error("Embedded math renderer unavailable");
    return new File(asset.localUri).text();
  })().catch(error => {
    pending = null;
    throw error;
  });
  return pending;
}
