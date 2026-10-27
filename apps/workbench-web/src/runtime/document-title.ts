/** The application shell is the only writer; background views never set a title. */
export function formatDocumentTitle(pageTitle: string | null | undefined, applicationName = "OpenCraft"): string {
  const title = pageTitle?.trim();
  return title ? `${title} · ${applicationName}` : applicationName;
}
