package policy

import (
	"fmt"
	"math"

	goja "hypernode/internal/policy/jsvm"
)

type policySQLExec func(string, []any) ([]string, [][]any, int64, error)

type sqlStateStore interface {
	ExecPolicySQL(string, []any) ([]string, [][]any, int64, error)
}

type transactionalSQLStateStore interface {
	TransactionPolicySQL(func(func(string, []any) ([]string, [][]any, int64, error)) error) error
}

type durableStorageBridge struct {
	store   StateStore
	sql     sqlStateStore
	current policySQLExec
}

func installDurableStorage(vm *goja.Runtime, stateStore StateStore) (*durableStorageBridge, error) {
	sqlStore, ok := stateStore.(sqlStateStore)
	if !ok {
		return nil, nil
	}
	bridge := &durableStorageBridge{store: stateStore, sql: sqlStore}
	storage := vm.NewObject()
	sqlObject := vm.NewObject()
	if err := sqlObject.Set("__exec", bridge.exec); err != nil {
		return nil, err
	}
	if err := storage.Set("sql", sqlObject); err != nil {
		return nil, err
	}
	if err := storage.Set("transactionSync", bridge.transactionSync); err != nil {
		return nil, err
	}
	if err := vm.Set("durableStorage", storage); err != nil {
		return nil, err
	}
	// QuickJS stores a C function's magic value in a signed 16-bit slot. A Go
	// callback therefore cannot safely be allocated for every SQL cursor: the
	// audit stream alone used to exhaust that slot after roughly 6,500 RPCs and
	// turn unrelated filesystem/Thread requests into `Function not found`.
	// Keep the sole native SQL entrypoint stable and implement cursor state with
	// ordinary JavaScript closures, which are owned and collected by QuickJS.
	bootstrap, err := vm.RunString(`(() => {
		const nativeExec = durableStorage.sql.__exec;
		const cursor = (snapshot, shared = { index: 0 }, raw = false) => ({
			columnNames: snapshot.columnNames,
			rowsRead: snapshot.rowsRead,
			rowsWritten: snapshot.rowsWritten,
			next() {
				if (shared.index >= snapshot.rows.length) return { done: true };
				const values = snapshot.rows[shared.index++];
				return { done: false, value: raw
					? values
					: Object.fromEntries(snapshot.columnNames.map((name, index) => [name, values[index]])) };
			},
			toArray() {
				const values = [];
				for (let item = this.next(); !item.done; item = this.next()) values.push(item.value);
				return values;
			},
			one() {
				const remaining = snapshot.rows.length - shared.index;
				if (remaining !== 1) throw new Error("expected exactly one SQL row, found " + remaining);
				return this.next().value;
			},
			raw() { return cursor(snapshot, shared, true); },
			[Symbol.iterator]() { return this; },
		});
		durableStorage.sql.exec = (...args) => cursor(nativeExec(...args));
		delete durableStorage.sql.__exec;
	})()`)
	if err != nil {
		return nil, fmt.Errorf("install durable SQL cursor: %w", err)
	}
	bootstrap.Free()
	return bridge, nil
}

func (b *durableStorageBridge) get(namespace, key string) (any, error) {
	if b.current == nil {
		value, found, err := b.store.Get(namespace, key)
		if err != nil || !found {
			return nil, err
		}
		return value, nil
	}
	_, rows, _, err := b.current(`SELECT value FROM policy_kv WHERE namespace=? AND key=?`, []any{namespace, key})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0][0], nil
}

func (b *durableStorageBridge) set(namespace, key, value string) error {
	if b.current == nil {
		return b.store.Set(namespace, key, value)
	}
	_, _, _, err := b.current(`INSERT INTO policy_kv(namespace, key, value, updated_at) VALUES(?,?,?,datetime('now'))
		ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, []any{namespace, key, value})
	return err
}

func (b *durableStorageBridge) delete(namespace, key string) (bool, error) {
	if b.current == nil {
		return b.store.Delete(namespace, key)
	}
	_, _, changed, err := b.current(`DELETE FROM policy_kv WHERE namespace=? AND key=?`, []any{namespace, key})
	return changed > 0, err
}

func (b *durableStorageBridge) getOrInsert(namespace, key, value string) (string, error) {
	if b.current == nil {
		return b.store.GetOrInsert(namespace, key, value)
	}
	if _, _, _, err := b.current(`INSERT INTO policy_kv(namespace, key, value, updated_at) VALUES(?,?,?,datetime('now'))
		ON CONFLICT(namespace, key) DO NOTHING`, []any{namespace, key, value}); err != nil {
		return "", err
	}
	stored, err := b.get(namespace, key)
	if err != nil {
		return "", err
	}
	value, ok := stored.(string)
	if !ok {
		return "", fmt.Errorf("policy store returned non-string value %T", stored)
	}
	return value, nil
}

func (b *durableStorageBridge) exec(call goja.FunctionCall) (map[string]any, error) {
	if len(call.Arguments) == 0 {
		return nil, fmt.Errorf("durableStorage.sql.exec requires a query")
	}
	query := call.Argument(0).String()
	bindings := make([]any, 0, len(call.Arguments)-1)
	for _, argument := range call.Arguments[1:] {
		binding, err := sqlBinding(argument.Export())
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	exec := b.current
	if exec == nil {
		exec = b.sql.ExecPolicySQL
	}
	columns, rows, rowsWritten, err := exec(query, bindings)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"columnNames": columns,
		"rows":        rows,
		"rowsRead":    int64(len(rows)),
		"rowsWritten": rowsWritten,
	}, nil
}

func (b *durableStorageBridge) transactionSync(call goja.FunctionCall) (any, error) {
	callback, ok := goja.AssertFunction(call.Argument(0))
	if !ok {
		return nil, fmt.Errorf("durableStorage.transactionSync requires a callback")
	}
	store, ok := b.sql.(transactionalSQLStateStore)
	if !ok {
		return nil, fmt.Errorf("durable SQL transactions are unavailable")
	}
	if b.current != nil {
		return nil, fmt.Errorf("nested durable SQL transactions are not supported")
	}
	var result any
	err := store.TransactionPolicySQL(func(exec func(string, []any) ([]string, [][]any, int64, error)) error {
		b.current = policySQLExec(exec)
		defer func() { b.current = nil }()
		value, err := callback(goja.Undefined())
		if err != nil {
			return err
		}
		result = value.Export()
		value.Free()
		return nil
	})
	return result, err
}

func sqlBinding(value any) (any, error) {
	switch value := value.(type) {
	case nil, string, bool, int, int32, int64, []byte:
		return value, nil
	case float32:
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, fmt.Errorf("durable SQL number bindings must be finite")
		}
		return value, nil
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("durable SQL number bindings must be finite")
		}
		return value, nil
	default:
		return nil, fmt.Errorf("unsupported durable SQL binding type %T", value)
	}
}
