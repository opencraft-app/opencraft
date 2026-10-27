// Stable runtime-facing names; implementation is shared with Host document APIs.
export {
  DOCUMENT_MAX_BYTES as EXTENSION_DATA_MAX_BYTES,
  MemoryDocumentPersistence as MemoryExtensionPersistence,
  serializeDocumentValue as serializeExtensionData,
  parseDocumentRecord as parseExtensionDataRecord,
  validateDataScope, validateDataRevision, validateDataVersion,
  validateDocumentTransition,
  type DocumentRecord as ExtensionDataRecord,
  type DocumentCommit as ExtensionDataCommit,
  type DocumentPersistence as ExtensionPersistence,
} from "@opencraft/document-storage";
