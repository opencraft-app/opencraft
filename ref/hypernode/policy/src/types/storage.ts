export type SqlBinding = null | string | boolean | number | Uint8Array;
export type SqlValue = SqlBinding;
export type SqlRow = Record<string, SqlValue>;

export interface DurableSqlCursor<Row extends SqlRow = SqlRow> extends IterableIterator<Row> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  next(): IteratorResult<Row, undefined>;
  toArray(): Row[];
  one(): Row;
  raw(): IterableIterator<SqlValue[]>;
}

export interface DurableSql {
  exec<Row extends SqlRow = SqlRow>(query: string, ...bindings: SqlBinding[]): DurableSqlCursor<Row>;
}

export interface DurableStorageNative {
  readonly sql: DurableSql;
  transactionSync<Result>(callback: () => Result): Result;
}

export interface DurableStoragePort {
  readonly available: boolean;
  readonly sql: DurableSql | null;
  transactionSync<Result>(callback: () => Result): Result;
}

export interface PolicyStorePort {
  get(namespace: string, key: string): string | null;
  set(namespace: string, key: string, value: string): void;
  delete(namespace: string, key: string): boolean;
  getOrInsert(namespace: string, key: string, candidate: string): string;
}
