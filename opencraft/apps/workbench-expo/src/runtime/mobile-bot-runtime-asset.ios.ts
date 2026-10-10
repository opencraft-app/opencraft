import { Asset } from "expo-asset";
import { File } from "expo-file-system";

let pending: Promise<string> | null = null;

/** Resolve the packaged Bot UI once, including the asset read, before it is shown. */
export function loadMobileBotRuntimeHtml(): Promise<string> {
  if (!pending) {
    pending = (async () => {
      const asset = Asset.fromModule(require("../../assets/mobile-bot-runtime.html") as number);
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error("Missing local Bot runtime");
      return new File(asset.localUri).text();
    })().catch(error => {
      pending = null;
      throw error;
    });
  }
  return pending;
}
