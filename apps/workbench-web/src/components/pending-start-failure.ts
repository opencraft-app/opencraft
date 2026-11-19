/** User-facing start failure. Protocol text stays in the developer log. */
export function pendingStartFailureMessage(message: string | null | undefined): { readonly id: string; readonly defaultMessage: string } {
  if (message && /permission profile/iu.test(message)) {
    return {
      id: "chat.start.permissionUnsupported",
      defaultMessage: "This agent cannot use the selected permission. Choose a supported permission and try again.",
    };
  }
  return { id: "chat.start.failedDetail", defaultMessage: "The task did not start. Try again." };
}
