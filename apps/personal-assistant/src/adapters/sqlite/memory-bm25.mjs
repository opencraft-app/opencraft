import { memoryLexicalTokens } from "../../domain/memory-recall.mjs";

/** Connection-local derived cache. Files remain authoritative; no persistent schema change. */
export function initializeMemoryBm25(db) {
  db.function("memory_fts_tokens", { deterministic: true }, (text) =>
    memoryLexicalTokens(text).join(" "),
  );
  db.exec(`
    CREATE VIRTUAL TABLE temp.memory_bm25 USING fts5(key UNINDEXED, tokens);
    INSERT INTO memory_bm25(key,tokens)
      SELECT key,memory_fts_tokens(key || ' ' || value) FROM main.memory WHERE deleted=0;
    CREATE TEMP TRIGGER memory_bm25_insert AFTER INSERT ON main.memory
      WHEN new.deleted=0 BEGIN
        INSERT INTO memory_bm25(key,tokens) VALUES(new.key,memory_fts_tokens(new.key || ' ' || new.value));
      END;
    CREATE TEMP TRIGGER memory_bm25_delete AFTER DELETE ON main.memory BEGIN
      DELETE FROM memory_bm25 WHERE key=old.key;
    END;
    CREATE TEMP TRIGGER memory_bm25_update AFTER UPDATE OF key,value,deleted ON main.memory BEGIN
      DELETE FROM memory_bm25 WHERE key=old.key;
      INSERT INTO memory_bm25(key,tokens)
        SELECT new.key,memory_fts_tokens(new.value) WHERE new.deleted=0;
    END;
  `);
}

// Query tokens are bounded by the caller and quoted as literal FTS terms.
export function memoryBm25Match(terms) {
  return terms
    .map((term) => '"' + term.replaceAll('"', '""') + '"')
    .join(" OR ");
}
