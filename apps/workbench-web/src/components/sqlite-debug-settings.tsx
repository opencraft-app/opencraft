import { ChevronLeftIcon as ChevronLeft, ChevronRightIcon as ChevronRight, RefreshIcon as RefreshCw } from "@opencraft/design-system-web/action-icons";
import { DatabaseIcon as Database, TableIcon as TableProperties } from "@opencraft/design-system-web/action-icons";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  SettingsButton,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSection,
} from "@opencraft/extension-react";

interface DebugDatabase {
  readonly id: string;
  readonly label: string;
  readonly exists: boolean;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number | null;
}

interface DebugTable {
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean; readonly primaryKey: boolean }[];
  readonly rowCount: number;
}

interface DebugRows {
  readonly databaseId: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

interface SqliteDebugPort {
  list(): Promise<readonly DebugDatabase[]>;
  tables(databaseId: string): Promise<readonly DebugTable[]>;
  rows(databaseId: string, table: string, offset: number, limit: number): Promise<DebugRows>;
}

function port(): SqliteDebugPort | null {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { sqliteDebug?: SqliteDebugPort } })
    .opencraftDesktop?.sqliteDebug ?? null;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function cellLabel(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  return String(value);
}

const PAGE_SIZE = 50;

export function SqliteDebugSettings() {
  const sqlite = useMemo(port, []);
  const [databases, setDatabases] = useState<readonly DebugDatabase[]>([]);
  const [databaseId, setDatabaseId] = useState<string | null>(null);
  const [tables, setTables] = useState<readonly DebugTable[]>([]);
  const [tableName, setTableName] = useState<string | null>(null);
  const [rows, setRows] = useState<DebugRows | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDatabases = useCallback(async () => {
    if (!sqlite) return;
    setLoading(true); setError(null);
    try {
      const next = await sqlite.list();
      setDatabases(next);
      setDatabaseId((current) => current && next.some((item) => item.id === current && item.exists)
        ? current : next.find((item) => item.exists)?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read OpenCraft databases.");
    } finally { setLoading(false); }
  }, [sqlite]);

  useEffect(() => { void loadDatabases(); }, [loadDatabases]);

  useEffect(() => {
    if (!sqlite || databaseId === null) { setTables([]); setTableName(null); return; }
    let current = true;
    setLoading(true); setError(null); setRows(null);
    void sqlite.tables(databaseId).then((next) => {
      if (!current) return;
      setTables(next);
      setTableName((selected) => selected && next.some((item) => item.name === selected)
        ? selected : next[0]?.name ?? null);
      setOffset(0);
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "Could not read database schema."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [databaseId, sqlite]);

  useEffect(() => {
    if (!sqlite || databaseId === null || tableName === null) { setRows(null); return; }
    let current = true;
    setLoading(true); setError(null);
    void sqlite.rows(databaseId, tableName, offset, PAGE_SIZE).then((next) => { if (current) setRows(next); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "Could not read table rows."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [databaseId, offset, sqlite, tableName]);

  if (!sqlite) {
    return <SettingsSection title="SQLite inspector" description="This debug surface is available in the Electron app only." />;
  }

  const selectedTable = tables.find((table) => table.name === tableName) ?? null;
  return (
    <>
      <SettingsPageHeader title="SQLite inspector" description="Inspect OpenCraft-owned local databases without changing them." />
      <SettingsNotice tone="neutral" title="Read-only developer tool">
        OpenCraft opens only its four known databases in SQLite query-only mode. SQL execution, file selection and data export are unavailable.
      </SettingsNotice>
      <SettingsSection title="Local databases" description="Data belongs to this application profile and can change while OpenCraft is running.">
        <div className="sqlite-debug-toolbar">
          <SettingsButton type="button" onClick={() => void loadDatabases()} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </SettingsButton>
          {loading ? <span role="status">Reading…</span> : null}
        </div>
        {error ? <div className="sqlite-debug-error" role="alert">{error}</div> : null}
        <div className="sqlite-debug-layout">
          <nav className="sqlite-debug-list" aria-label="OpenCraft databases">
            {databases.map((database) => (
              <button type="button" key={database.id} disabled={!database.exists}
                aria-current={database.id === databaseId ? "page" : undefined}
                onClick={() => { setDatabaseId(database.id); setTableName(null); setRows(null); setOffset(0); }}>
                <Database size={15} aria-hidden="true" />
                <span><strong>{database.label}</strong><small>{database.exists ? sizeLabel(database.sizeBytes) : "Not created"}</small></span>
              </button>
            ))}
          </nav>
          <nav className="sqlite-debug-list" aria-label="Database tables">
            {tables.map((table) => (
              <button type="button" key={table.name} aria-current={table.name === tableName ? "page" : undefined}
                onClick={() => { setTableName(table.name); setOffset(0); }}>
                <TableProperties size={15} aria-hidden="true" />
                <span><strong>{table.name}</strong><small>{table.rowCount.toLocaleString()} rows</small></span>
              </button>
            ))}
            {databaseId !== null && tables.length === 0 && !loading ? <p>No application tables.</p> : null}
          </nav>
        </div>
      </SettingsSection>
      {selectedTable === null || rows === null ? null : (
        <SettingsSection title={selectedTable.name} description={selectedTable.columns.map((column) => `${column.name} · ${column.type}`).join("  |  ")}>
          <div className="sqlite-debug-table-wrap">
            <table className="sqlite-debug-table">
              <thead><tr>{rows.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{rows.rows.map((row, rowIndex) => (
                <tr key={`${rows.offset}:${rowIndex}`}>{rows.columns.map((column) => (
                  <td key={column} title={cellLabel(row[column] ?? null)}>{cellLabel(row[column] ?? null)}</td>
                ))}</tr>
              ))}</tbody>
            </table>
            {rows.rows.length === 0 ? <div className="settings-empty-state">No rows on this page.</div> : null}
          </div>
          <div className="sqlite-debug-pagination" aria-label="Table pagination">
            <SettingsButton type="button" disabled={rows.offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, rows.offset - PAGE_SIZE))}>
              <ChevronLeft size={14} aria-hidden="true" /> Previous
            </SettingsButton>
            <span>{rows.total === 0 ? "0 rows" : `${rows.offset + 1}–${Math.min(rows.offset + rows.limit, rows.total)} of ${rows.total}`}</span>
            <SettingsButton type="button" disabled={rows.offset + rows.limit >= rows.total || loading}
              onClick={() => setOffset(rows.offset + PAGE_SIZE)}>
              Next <ChevronRight size={14} aria-hidden="true" />
            </SettingsButton>
          </div>
        </SettingsSection>
      )}
    </>
  );
}
