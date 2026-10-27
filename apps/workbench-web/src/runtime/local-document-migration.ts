import type { ClientLocalDocuments } from "@opencraft/document-storage/client-local-documents";
import { ClientResourceScopeChangedError } from "@opencraft/document-storage/client-resources";

/** Legacy is a read-only migration source. A failed import never removes it. */
export async function readMigratingLocalDocument(documents: ClientLocalDocuments, key: string, legacy: Pick<Storage, "getItem" | "removeItem">): Promise<string | null> {
  let current: string | null | undefined;
  try { current = await documents.read(key); }
  catch (error) {
    if (error instanceof ClientResourceScopeChangedError) throw error;
    const previous = legacy.getItem(key);
    if (previous !== null) return previous;
    throw error;
  }
  if (current !== undefined) return current;
  const previous = legacy.getItem(key);
  if (previous === null) return null;
  try { await documents.write(key, previous); }
  catch (error) { if (error instanceof ClientResourceScopeChangedError) throw error; return previous; }
  // Another old page may still be editing. Never erase bytes we did not import.
  try { if (legacy.getItem(key) === previous) legacy.removeItem(key); } catch { /* The accepted copy is authoritative; its source remains recoverable. */ }
  return previous;
}
