import { createDeferredView } from "@opencraft/extension-react";
/** Server settings load only when their route is mounted, not with the chat startup graph. */
export const ServerInformationSettings = createDeferredView(
  async () => (await import("./server-information-settings-content")).ServerInformationSettings,
);
