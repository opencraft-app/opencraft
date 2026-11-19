import { lazy, Suspense } from "react";
import type { FilePreviewInput } from "./index";
const View = lazy(() => import("./file-preview-view").then((module) => ({ default: module.FilePreviewView })));
export function FilePreviewView(
  props: FilePreviewInput & {
    active?: boolean;
    download?: boolean;
    dark: boolean;
    onOpenLink?(url: string): void;
    prepare(signal?: AbortSignal): Promise<void>;
  },
) {
  return (
    <Suspense fallback={null}>
      <View {...props} />
    </Suspense>
  );
}
