import type { LocaleCatalog } from "@opencraft/i18n";

/** Composition adds messages, never language selection or a second Intl owner. */
export function withProductCatalogs(base: readonly LocaleCatalog[], additions: readonly LocaleCatalog[]): readonly LocaleCatalog[] {
  return base.map(catalog => {
    const matches = additions.filter(addition => addition.locale === catalog.locale);
    if (!matches.length) return catalog;
    return { ...catalog, async load() {
      const catalogs = await Promise.all([catalog, ...matches].map(entry => entry.load()));
      const messages: Record<string, string> = {};
      for (const entries of catalogs) for (const [id, message] of Object.entries(entries)) {
        if (Object.hasOwn(messages, id)) throw new Error("Product catalog conflicts with an existing message: " + id);
        messages[id] = message;
      }
      return messages;
    } };
  });
}
