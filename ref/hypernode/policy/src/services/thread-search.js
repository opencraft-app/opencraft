import { Service } from "@deepseek-ai/cordis";

const SEARCH_SCHEMA_VERSION = 4;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RECORD_BACKFILL_BATCH = 50;
const EVENT_BACKFILL_BATCH = 16;
const BASE_INDEX = "do_thread_search_fts";
const TRIGRAM_INDEX = "do_thread_search_fts_trigram";
const CJK_INDEX = "do_thread_search_fts_cjk";
const SEARCH_INDEXES = [BASE_INDEX, TRIGRAM_INDEX, CJK_INDEX];

function normalizedQuery(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function ftsPhrase(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function codePointLength(value) {
  return [...value].length;
}

function isCjkCodePoint(codePoint) {
  return (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af);
}

function cjkRuns(value) {
  const runs = [];
  let current = [];
  for (const character of value) {
    if (isCjkCodePoint(character.codePointAt(0))) current.push(character);
    else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function containsCjk(value) {
  return cjkRuns(value).length > 0;
}

function hasLoneCjkRun(value) {
  return cjkRuns(value).some((run) => run.length === 1);
}

function cjkBigramQuery(value) {
  const phrases = cjkRuns(value).filter((run) => run.length >= 2).map((run) => {
    const bigrams = [];
    for (let index = 0; index < run.length - 1; index += 1) {
      bigrams.push(`${run[index]}${run[index + 1]}`);
    }
    return ftsPhrase(bigrams.join(" "));
  });
  return phrases.join(" AND ");
}

export function searchRouteForQuery(value) {
  const query = normalizedQuery(value);
  if (!containsCjk(query)) return "fts";
  return hasLoneCjkRun(query) ? "like" : "cjk";
}

function sqlCjkCharacter(expression) {
  const point = `unicode(${expression})`;
  return `(
    (${point} BETWEEN 19968 AND 40959) OR
    (${point} BETWEEN 13312 AND 19903) OR
    (${point} BETWEEN 131072 AND 173791) OR
    (${point} BETWEEN 12288 AND 12351) OR
    (${point} BETWEEN 12352 AND 12447) OR
    (${point} BETWEEN 12448 AND 12543) OR
    (${point} BETWEEN 44032 AND 55215)
  )`;
}

// A portable equivalent of Hermes' optional cjk_unicode61 extension. SQLite's
// substr()/unicode() are code-point aware, so the projection can materialize
// overlapping CJK bigrams without adding a native extension to the JS host.
function cjkBigramSql(expression) {
  return `coalesce((
    WITH RECURSIVE offsets(position) AS (
      SELECT 1 WHERE length(${expression}) >= 2
      UNION ALL
      SELECT position + 1 FROM offsets WHERE position + 1 < length(${expression})
    )
    SELECT group_concat(substr(${expression}, position, 2), ' ')
    FROM offsets
    WHERE ${sqlCjkCharacter(`substr(${expression}, position, 1)`)}
      AND ${sqlCjkCharacter(`substr(${expression}, position + 1, 1)`)}
  ), '')`;
}

export function searchQueryFromInput(input = []) {
  const text = input
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.replaceAll("&#x20;", " "))
    .join("\n")
    .replace(/\[\$(?:search|search-conversations|global-search|conversation-search)\]\([^)]+\)/gi, " ")
    .replace(/(?:^|\s)\$(?:search|search-conversations|global-search|conversation-search)\b/gi, " ");
  return normalizedQuery(text);
}

function searchTextSql(mode, expression = "content") {
  if (mode === "cjk") return `${expression} || char(10) || ${cjkBigramSql(expression)}`;
  return expression;
}

function insertRecordSql(table, mode, prefix = "", from = "", predicate = "") {
  return `
    INSERT INTO ${table}(
      principal_id, source_type, thread_id, turn_id, item_id, role,
      search_text, content, occurred_at_ms
    )
    SELECT principal_id, 'thread', thread_id, '', '', 'thread',
      ${searchTextSql(mode)}, content, occurred_at_ms
    FROM (
      SELECT
        ${prefix}principal_id AS principal_id,
        ${prefix}thread_id AS thread_id,
        trim(coalesce(json_extract(${prefix}payload, '$.thread.name'), '') || char(10) ||
             coalesce(json_extract(${prefix}payload, '$.thread.preview'), '')) AS content,
        coalesce(json_extract(${prefix}payload, '$.thread.updatedAt'), 0) * 1000 AS occurred_at_ms
      ${from}
      ${predicate ? `WHERE ${predicate}` : ""}
    )
    WHERE content <> ''
  `;
}

function insertCanonicalItemSql(table, mode, prefix = "", source = "", predicate = "") {
  const excludeTools = mode === "fts" ? "" : "AND role <> 'tool'";
  return `
    INSERT INTO ${table}(
      principal_id, source_type, thread_id, turn_id, item_id, role,
      search_text, content, occurred_at_ms
    )
    SELECT principal_id, 'item', thread_id, turn_id, item_id, role,
      ${searchTextSql(mode)}, content, occurred_at_ms
    FROM (
      SELECT
        record.principal_id AS principal_id,
        ${prefix}thread_id AS thread_id,
        coalesce(${prefix}turn_id, '') AS turn_id,
        coalesce(${prefix}item_id, '') AS item_id,
        coalesce(${prefix}search_role, 'unknown') AS role,
        ${prefix}search_text AS content,
        coalesce(${prefix}occurred_at_ms, 0) AS occurred_at_ms
      FROM ${source}
      JOIN do_thread_catalog_records AS record ON record.thread_id = ${prefix}thread_id
      WHERE ${prefix}event_type = 'item.completed'
        AND ${prefix}epoch = (
          SELECT head.epoch FROM hypernode_canonical_timeline_heads AS head
          WHERE head.thread_id = ${prefix}thread_id
        )
        AND ${prefix}search_text IS NOT NULL
        ${predicate ? `AND ${predicate}` : ""}
    )
    WHERE content IS NOT NULL AND trim(content) <> ''
      ${excludeTools}
  `;
}

function insertRecordIndexes(prefix = "", from = "", predicate = "") {
  return recordIndexStatements(prefix, from, predicate).join(";\n");
}

function recordIndexStatements(prefix = "", from = "", predicate = "") {
  return [
    insertRecordSql(BASE_INDEX, "fts", prefix, from, predicate),
    insertRecordSql(TRIGRAM_INDEX, "trigram", prefix, from, predicate),
    insertRecordSql(CJK_INDEX, "cjk", prefix, from, predicate),
  ];
}

function insertCanonicalItemIndexes(prefix = "", source = "", predicate = "") {
  return canonicalItemIndexStatements(prefix, source, predicate).join(";\n");
}

function canonicalItemIndexStatements(prefix = "", source = "", predicate = "") {
  return [
    insertCanonicalItemSql(BASE_INDEX, "fts", prefix, source, predicate),
    insertCanonicalItemSql(TRIGRAM_INDEX, "trigram", prefix, source, predicate),
    insertCanonicalItemSql(CJK_INDEX, "cjk", prefix, source, predicate),
  ];
}

export class ThreadSearchService extends Service {
  constructor(ctx) {
    super(ctx, "threadSearch");
    this.storage = ctx.storage;
    this.available = this.storage?.available === true && this.storage?.sql != null;
    this.backfillInProgress = false;
    this.backfillScheduled = false;
    this.backfillCancelled = false;
    this.backfillNeedsStart = false;
    if (this.available && this.initialize()) {
      this.backfillInProgress = true;
      this.backfillNeedsStart = true;
      this.scheduleBackfill();
      ctx.effect(() => {
        return () => {
          this.backfillCancelled = true;
          this.backfillScheduled = false;
        };
      });
    }
  }

  initialize() {
    const sql = this.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS do_thread_search_meta (
        schema_version INTEGER PRIMARY KEY,
        indexed_at_ms INTEGER NOT NULL
      )
    `);

    for (const trigger of [
      "do_thread_search_record_insert", "do_thread_search_record_update", "do_thread_search_record_delete",
      "do_thread_search_canonical_insert", "do_thread_search_canonical_epoch_update",
      // Drop names used by pre-canonical releases without depending on their
      // source table. SQLite permits dropping a trigger after its table was
      // retained solely for the offline importer.
      "do_thread_search_turn_insert", "do_thread_search_turn_update", "do_thread_search_turn_delete",
    ]) sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);

    const indexed = sql.exec(
      "SELECT 1 AS present FROM do_thread_search_meta WHERE schema_version = ?",
      SEARCH_SCHEMA_VERSION,
    ).toArray()[0];
    if (!indexed) {
      for (const table of SEARCH_INDEXES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }

    const columns = `
      principal_id UNINDEXED,
      source_type UNINDEXED,
      thread_id UNINDEXED,
      turn_id UNINDEXED,
      item_id UNINDEXED,
      role UNINDEXED,
      search_text,
      content UNINDEXED,
      occurred_at_ms UNINDEXED
    `;
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${BASE_INDEX} USING fts5(
        ${columns}, tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
    this.trigramAvailable = true;
    try {
      sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${TRIGRAM_INDEX} USING fts5(
          ${columns}, tokenize = 'trigram'
        )
      `);
    } catch (error) {
      this.trigramAvailable = false;
      console.warn(`[thread-search] trigram tokenizer unavailable: ${error?.message ?? error}`);
      // Keep trigger/backfill generation uniform on old SQLite builds. This
      // fallback table is queried only if trigramAvailable remains true.
      sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${TRIGRAM_INDEX} USING fts5(
          ${columns}, tokenize = 'unicode61 remove_diacritics 2'
        )
      `);
    }
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${CJK_INDEX} USING fts5(
        ${columns}, tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
    this.cjkAvailable = true;

    sql.exec(`
      CREATE TRIGGER do_thread_search_record_insert AFTER INSERT ON do_thread_catalog_records BEGIN
        ${insertRecordIndexes("new.")};
        ${insertCanonicalItemIndexes(
          "entry.",
          "hypernode_canonical_timeline_entries AS entry",
          "record.rowid = new.rowid",
        )};
      END
    `);
    sql.exec(`
      CREATE TRIGGER do_thread_search_record_update AFTER UPDATE ON do_thread_catalog_records
      WHEN json_extract(old.payload, '$.thread.name')
             IS NOT json_extract(new.payload, '$.thread.name')
        OR json_extract(old.payload, '$.thread.preview')
             IS NOT json_extract(new.payload, '$.thread.preview')
      BEGIN
        ${SEARCH_INDEXES.map((table) => `DELETE FROM ${table}
          WHERE principal_id = old.principal_id AND thread_id = old.thread_id
            AND source_type = 'thread'`).join(";\n        ")};
        ${insertRecordIndexes("new.")};
      END
    `);
    sql.exec(`
      CREATE TRIGGER do_thread_search_record_delete AFTER DELETE ON do_thread_catalog_records BEGIN
        ${SEARCH_INDEXES.map((table) => `DELETE FROM ${table}
          WHERE principal_id = old.principal_id AND thread_id = old.thread_id`).join(";\n        ")};
      END
    `);
    sql.exec(`
      CREATE TRIGGER do_thread_search_canonical_insert
      AFTER INSERT ON hypernode_canonical_timeline_entries BEGIN
        ${insertCanonicalItemIndexes(
          "entry.",
          "hypernode_canonical_timeline_entries AS entry",
          "entry.rowid = new.rowid",
        )};
      END
    `);
    sql.exec(`
      CREATE TRIGGER do_thread_search_canonical_epoch_update
      AFTER UPDATE OF epoch ON hypernode_canonical_timeline_heads
      WHEN old.epoch <> new.epoch BEGIN
        ${SEARCH_INDEXES.map((table) => `DELETE FROM ${table}
          WHERE thread_id = old.thread_id AND source_type = 'item'`).join(";\n        ")};
        ${insertCanonicalItemIndexes(
          "entry.",
          "hypernode_canonical_timeline_entries AS entry",
          "entry.thread_id = new.thread_id AND entry.epoch = new.epoch",
        )};
      END
    `);
    return !indexed;
  }

  startBackfill() {
    this.backfillNeedsStart = false;
    const sql = this.storage.sql;
    try {
      this.storage.transactionSync(() => {
        for (const table of SEARCH_INDEXES) sql.exec(`DELETE FROM ${table}`);
        sql.exec("DELETE FROM do_thread_search_meta");
      });
      this.backfill = {
        phase: "records",
        cursor: 0,
        recordMax: Number(sql.exec(
          "SELECT coalesce(max(rowid), 0) AS value FROM do_thread_catalog_records",
        ).toArray()[0]?.value) || 0,
        eventMax: Number(sql.exec(
          "SELECT coalesce(max(rowid), 0) AS value FROM hypernode_canonical_timeline_entries",
        ).toArray()[0]?.value) || 0,
        startedAtMs: Date.now(),
      };
      this.scheduleBackfill();
    } catch (error) {
      this.failBackfill(error);
    }
  }

  scheduleBackfill() {
    if (this.backfillCancelled) return;
    this.backfillScheduled = true;
    if (typeof globalThis.hostEvents?.wakeAfter === "function") {
      globalThis.hostEvents.wakeAfter(0);
    }
  }

  // The outer host calls policy.onTick after wakeAfter(). Run exactly one
  // bounded batch per Tick so SQLite backfill never monopolizes QuickJS.
  tick() {
    if (!this.backfillScheduled || this.backfillCancelled) return false;
    this.backfillScheduled = false;
    if (this.backfillNeedsStart) this.startBackfill();
    else this.backfillStep();
    return true;
  }

  backfillStep() {
    const sql = this.storage.sql;
    const state = this.backfill;
    if (!state) return;
    try {
      if (state.phase === "records") {
        const rows = sql.exec(`
          SELECT rowid, principal_id, thread_id
          FROM do_thread_catalog_records
          WHERE rowid > ? AND rowid <= ?
          ORDER BY rowid
          LIMIT ?
        `, state.cursor, state.recordMax, RECORD_BACKFILL_BATCH).toArray();
        if (rows.length === 0) {
          state.phase = "events";
          state.cursor = 0;
          this.scheduleBackfill();
          return;
        }
        this.storage.transactionSync(() => {
          for (const row of rows) {
            for (const table of SEARCH_INDEXES) sql.exec(`
              DELETE FROM ${table}
              WHERE principal_id = ? AND thread_id = ? AND source_type = 'thread'
            `, row.principal_id, row.thread_id);
            for (const statement of recordIndexStatements(
              "record.", "FROM do_thread_catalog_records AS record", "record.rowid = ?",
            )) sql.exec(statement, row.rowid);
          }
        });
        state.cursor = Number(rows[rows.length - 1].rowid);
        this.scheduleBackfill();
        return;
      }

      const rows = sql.exec(`
        SELECT rowid, thread_id
        FROM hypernode_canonical_timeline_entries
        WHERE rowid > ? AND rowid <= ?
        ORDER BY rowid
        LIMIT ?
      `, state.cursor, state.eventMax, EVENT_BACKFILL_BATCH).toArray();
      if (rows.length === 0) {
        sql.exec(
          "INSERT INTO do_thread_search_meta(schema_version, indexed_at_ms) VALUES(?, ?)",
          SEARCH_SCHEMA_VERSION,
          Date.now(),
        );
        this.backfill = null;
        this.backfillInProgress = false;
        console.info(`[thread-search] FTS5 backfill completed in ${Date.now() - state.startedAtMs}ms`);
        return;
      }
      this.storage.transactionSync(() => {
        for (const row of rows) {
          for (const statement of canonicalItemIndexStatements(
            "entry.", "hypernode_canonical_timeline_entries AS entry", "entry.rowid = ?",
          )) sql.exec(statement, row.rowid);
        }
      });
      state.cursor = Number(rows[rows.length - 1].rowid);
      this.scheduleBackfill();
    } catch (error) {
      this.failBackfill(error);
    }
  }

  failBackfill(error) {
    this.backfill = null;
    this.backfillInProgress = false;
    console.error(`[thread-search] FTS5 backfill failed: ${error?.message ?? error}`);
  }

  search(query, options = {}) {
    query = normalizedQuery(query);
    if (!query || !this.available) return [];
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_LIMIT));
    const excludeThreadId = normalizedQuery(options.excludeThreadId);
    const exclusionSql = excludeThreadId ? "AND search.thread_id <> ?" : "";
    const exclusionBindings = excludeThreadId ? [excludeThreadId] : [];
    const visibilityFiltered = Object.prototype.hasOwnProperty.call(options, "actorPrincipalId");
    const actorPrincipalId = typeof options.actorPrincipalId === "string"
      ? options.actorPrincipalId
      : null;
    const visibilitySql = visibilityFiltered ? `AND (
      coalesce(json_extract(record.payload, '$.visibility'), 'private') <> 'private'
      OR json_extract(record.payload, '$.ownerPrincipalId') = ?
    )` : "";
    const visibilityBindings = visibilityFiltered ? [actorPrincipalId] : [];
    const commonSelect = (table) => `
      SELECT
        search.thread_id,
        search.turn_id,
        search.item_id,
        search.role,
        search.content,
        search.occurred_at_ms,
        coalesce(json_extract(record.payload, '$.thread.name'), 'Untitled') AS thread_name,
        coalesce(json_extract(record.payload, '$.archived'), 0) AS archived
      FROM ${table} AS search
      LEFT JOIN do_thread_catalog_records AS record
        ON record.principal_id = search.principal_id AND record.thread_id = search.thread_id
    `;
    const match = (table, matchQuery, extra = "") => this.storage.sql.exec(`
      ${commonSelect(table)}
      WHERE ${table} MATCH ? ${extra} ${visibilitySql} ${exclusionSql}
      ORDER BY rank, search.occurred_at_ms DESC
      LIMIT ?
    `, matchQuery, ...visibilityBindings, ...exclusionBindings, limit).toArray();
    const like = (extra = "") => this.storage.sql.exec(`
      ${commonSelect(BASE_INDEX)}
      WHERE instr(lower(search.content), lower(?)) > 0 ${extra} ${visibilitySql} ${exclusionSql}
      ORDER BY search.occurred_at_ms DESC
      LIMIT ?
    `, query, ...visibilityBindings, ...exclusionBindings, limit).toArray();

    const route = searchRouteForQuery(query);
    let rows;
    if (route === "like") {
      rows = like();
    } else if (route === "cjk" && this.cjkAvailable !== false) {
      rows = match(CJK_INDEX, cjkBigramQuery(query));
      // Tool output is deliberately absent from the expensive CJK/trigram
      // indexes, but remains available through the ordinary FTS projection.
      // Exact base-token hits are merged without inflating CJK index storage.
      rows.push(...match(BASE_INDEX, ftsPhrase(query), "AND search.role = 'tool'"));
    } else if (route === "cjk" && this.trigramAvailable !== false && codePointLength(query) >= 3) {
      rows = match(TRIGRAM_INDEX, ftsPhrase(query));
      rows.push(...match(BASE_INDEX, ftsPhrase(query), "AND search.role = 'tool'"));
    } else if (route === "cjk") {
      rows = like();
    } else {
      rows = match(BASE_INDEX, ftsPhrase(query));
    }
    const seen = new Set();
    return rows.filter((row) => {
      const key = `${row.thread_id}\u0000${row.turn_id}\u0000${row.item_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit).map((row) => ({
      threadId: row.thread_id,
      turnId: row.turn_id || null,
      itemId: row.item_id || null,
      role: row.role,
      content: row.content,
      occurredAtMs: Number(row.occurred_at_ms) || 0,
      threadName: row.thread_name,
      archived: Number(row.archived) === 1,
    }));
  }

  render(input, options = {}) {
    const query = searchQueryFromInput(input);
    if (!query) return "请输入搜索内容，例如：`$search 登录失败`。";
    const results = this.search(query, options);
    if (results.length === 0 && this.backfillInProgress) {
      return `会话索引仍在后台构建，暂未找到“${query}”；请稍后重试。`;
    }
    if (results.length === 0) return `没有找到包含“${query}”的会话。`;
    const lines = [`会话全文搜索：${query}`, ""];
    for (const result of results) {
      const compact = result.content.replace(/\s+/g, " ").trim();
      const excerpt = compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
      const state = result.archived ? " · 已归档" : "";
      lines.push(`- **${result.threadName}**${state} · ${result.role}`);
      lines.push(`  ${excerpt}`);
      lines.push(`  Thread: \`${result.threadId}\`${result.turnId ? ` · Turn: \`${result.turnId}\`` : ""}`);
    }
    return lines.join("\n");
  }
}

ThreadSearchService.inject = ["canonicalTimeline", "storage", "threadManager"];
